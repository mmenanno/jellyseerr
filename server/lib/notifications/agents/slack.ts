import { TemplateEngine } from '@server/lib/notifications/templateEngine';
import type { NotificationAgentSlack } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import { hasNotificationType, Notification } from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

interface EmbedField {
  type: 'plain_text' | 'mrkdwn';
  text: string;
}

interface TextItem {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

interface Element {
  type: 'button';
  text?: TextItem;
  action_id: string;
  url?: string;
  value?: string;
  style?: 'primary' | 'danger';
}

interface EmbedBlock {
  type: 'header' | 'actions' | 'section' | 'context';
  block_id?: 'section789';
  text?: TextItem;
  fields?: EmbedField[];
  accessory?: {
    type: 'image';
    image_url: string;
    alt_text: string;
  };
  elements?: (Element | TextItem)[];
}

interface SlackBlockEmbed {
  text: string;
  blocks: EmbedBlock[];
}

class SlackAgent
  extends BaseAgent<NotificationAgentSlack>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentSlack {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.slack;
  }

  public buildEmbed(
    type: Notification,
    payload: NotificationPayload
  ): SlackBlockEmbed {
    const settings = getSettings();
    const { applicationUrl, applicationTitle } = settings.main;
    const { embedPoster } = settings.notifications.agents.slack;

    const fields: EmbedField[] = [];

    if (payload.request) {
      const requestedByText = TemplateEngine.render(
        `*Requested By*\n{{requestedBy_username}}`,
        payload,
        type
      );

      fields.push({
        type: 'mrkdwn',
        text: requestedByText,
      });

      let status = '';
      switch (type) {
        case Notification.MEDIA_PENDING:
          status = 'Pending Approval';
          break;
        case Notification.MEDIA_APPROVED:
        case Notification.MEDIA_AUTO_APPROVED:
          status = 'Processing';
          break;
        case Notification.MEDIA_AVAILABLE:
          status = 'Available';
          break;
        case Notification.MEDIA_DECLINED:
          status = 'Declined';
          break;
        case Notification.MEDIA_FAILED:
          status = 'Failed';
          break;
      }

      if (status) {
        fields.push({
          type: 'mrkdwn',
          text: `*Request Status*\n${status}`,
        });
      }
    } else if (payload.comment) {
      const commentText = TemplateEngine.render(
        `*Comment from {{commentedBy_username}}*\n{{comment_message}}`,
        payload,
        type
      );

      fields.push({
        type: 'mrkdwn',
        text: commentText,
      });
    } else if (payload.issue) {
      const reportedByText = TemplateEngine.render(
        `*Reported By*\n{{reportedBy_username}}`,
        payload,
        type
      );
      const issueTypeText = TemplateEngine.render(
        `*Issue Type*\n{{issue_type}}`,
        payload,
        type
      );
      const issueStatusText = TemplateEngine.render(
        `*Issue Status*\n{{issue_status}}`,
        payload,
        type
      );

      fields.push(
        {
          type: 'mrkdwn',
          text: reportedByText,
        },
        {
          type: 'mrkdwn',
          text: issueTypeText,
        },
        {
          type: 'mrkdwn',
          text: issueStatusText,
        }
      );
    }

    for (const extra of payload.extra ?? []) {
      fields.push({
        type: 'mrkdwn',
        text: `*${extra.name}*\n${extra.value}`,
      });
    }

    const blocks: EmbedBlock[] = [];

    if (payload.event) {
      const eventText = TemplateEngine.render(`*{{event}}*`, payload, type);

      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: eventText,
          },
        ],
      });
    }

    const subjectText = TemplateEngine.render(`{{subject}}`, payload, type);

    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: subjectText,
      },
    });

    if (payload.message) {
      const messageText = TemplateEngine.render(`{{message}}`, payload, type);

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: messageText,
        },
        accessory:
          embedPoster && payload.image
            ? {
                type: 'image',
                image_url: payload.image,
                alt_text: subjectText,
              }
            : undefined,
      });
    }

    if (fields.length > 0) {
      blocks.push({
        type: 'section',
        fields,
      });
    }

    const url = applicationUrl
      ? payload.issue
        ? `${applicationUrl}/issues/${payload.issue.id}`
        : payload.media
        ? `${applicationUrl}/${payload.media.mediaType}/${payload.media.tmdbId}`
        : undefined
      : undefined;

    if (url) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            action_id: 'open-in-seerr',
            type: 'button',
            url,
            text: {
              type: 'plain_text',
              text: `View ${
                payload.issue ? 'Issue' : 'Media'
              } in ${applicationTitle}`,
            },
          },
        ],
      });
    }

    const text = TemplateEngine.render(
      payload.event ? `{{event}}` : `{{subject}}`,
      payload,
      type
    );

    return {
      text,
      blocks,
    };
  }

  public shouldSend(): boolean {
    const settings = this.getSettings();

    if (settings.enabled && settings.options.webhookUrl) {
      return true;
    }

    return false;
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    const settings = this.getSettings();

    if (
      !payload.notifySystem ||
      !hasNotificationType(type, settings.types ?? 0)
    ) {
      return true;
    }

    logger.debug('Sending Slack notification', {
      label: 'Notifications',
      type: Notification[type],
      subject: payload.subject,
    });
    try {
      await axios.post(
        settings.options.webhookUrl,
        this.buildEmbed(type, payload)
      );

      return true;
    } catch (e) {
      logger.error('Error sending Slack notification', {
        label: 'Notifications',
        type: Notification[type],
        subject: payload.subject,
        errorMessage: e.message,
        response: e?.response?.data,
      });

      return false;
    }
  }
}

export default SlackAgent;
