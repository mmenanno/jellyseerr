import { TemplateEngine } from '@server/lib/notifications/templateEngine';
import type { NotificationAgentNtfy } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import { hasNotificationType, Notification } from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

class NtfyAgent
  extends BaseAgent<NotificationAgentNtfy>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentNtfy {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.ntfy;
  }

  private buildPayload(type: Notification, payload: NotificationPayload) {
    const settings = getSettings();
    const { applicationUrl } = settings.main;
    const { embedPoster } = settings.notifications.agents.ntfy;

    const topic = this.getSettings().options.topic;
    const priority = 3;

    const titleTemplate = payload.event
      ? `{{event}} - {{subject}}`
      : `{{subject}}`;

    let messageTemplate = `{{message}}`;

    if (payload.request) {
      messageTemplate += `\n\nRequested By: {{requestedBy_username}}`;

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
        messageTemplate += `\nRequest Status: ${status}`;
      }
    } else if (payload.comment) {
      messageTemplate += `\nComment from {{commentedBy_username}}:\n{{comment_message}}`;
    } else if (payload.issue) {
      messageTemplate += `\n\nReported By: {{reportedBy_username}}`;
      messageTemplate += `\nIssue Type: {{issue_type}}`;
      messageTemplate += `\nIssue Status: {{issue_status}}`;
    }

    for (const extra of payload.extra ?? []) {
      messageTemplate += `\n\n**${extra.name}**\n${extra.value}`;
    }

    const title = TemplateEngine.render(titleTemplate, payload, type);
    const message = TemplateEngine.render(messageTemplate, payload, type);

    const attach = embedPoster ? payload.image : undefined;

    let click;
    if (applicationUrl && payload.media) {
      click = `${applicationUrl}/${payload.media.mediaType}/${payload.media.tmdbId}`;
    }

    return {
      topic,
      priority,
      title,
      message,
      attach,
      click,
    };
  }

  public shouldSend(): boolean {
    const settings = this.getSettings();

    if (settings.enabled && settings.options.url && settings.options.topic) {
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

    logger.debug('Sending ntfy notification', {
      label: 'Notifications',
      type: Notification[type],
      subject: payload.subject,
    });

    try {
      let authHeader;
      if (
        settings.options.authMethodUsernamePassword &&
        settings.options.username &&
        settings.options.password
      ) {
        const encodedAuth = Buffer.from(
          `${settings.options.username}:${settings.options.password}`
        ).toString('base64');

        authHeader = `Basic ${encodedAuth}`;
      } else if (settings.options.authMethodToken) {
        authHeader = `Bearer ${settings.options.token}`;
      }

      await axios.post(
        settings.options.url,
        this.buildPayload(type, payload),
        authHeader
          ? {
              headers: {
                Authorization: authHeader,
              },
            }
          : undefined
      );

      return true;
    } catch (e) {
      logger.error('Error sending ntfy notification', {
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

export default NtfyAgent;
