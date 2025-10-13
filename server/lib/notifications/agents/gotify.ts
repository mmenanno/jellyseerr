import { TemplateEngine } from '@server/lib/notifications/templateEngine';
import type { NotificationAgentGotify } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import { hasNotificationType, Notification } from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

interface GotifyPayload {
  title: string;
  message: string;
  priority: number;
  extras: Record<string, unknown>;
}

class GotifyAgent
  extends BaseAgent<NotificationAgentGotify>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentGotify {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.gotify;
  }

  public shouldSend(): boolean {
    const settings = this.getSettings();

    if (
      settings.enabled &&
      settings.options.url &&
      settings.options.token &&
      settings.options.priority !== undefined
    ) {
      return true;
    }

    return false;
  }

  private getNotificationPayload(
    type: Notification,
    payload: NotificationPayload
  ): GotifyPayload {
    const { applicationUrl, applicationTitle } = getSettings().main;
    const settings = this.getSettings();
    const priority = settings.options.priority ?? 1;

    const titleTemplate = payload.event
      ? `{{event}} - {{subject}}`
      : `{{subject}}`;

    let messageTemplate = payload.message ? `{{message}}  \n\n` : '';

    if (payload.request) {
      messageTemplate += `\n**Requested By:** {{requestedBy_username}}  `;

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
        messageTemplate += `\n**Request Status:** ${status}  `;
      }
    } else if (payload.comment) {
      messageTemplate += `\nComment from {{commentedBy_username}}:\n{{comment_message}}  `;
    } else if (payload.issue) {
      messageTemplate += `\n\n**Reported By:** {{reportedBy_username}}  `;
      messageTemplate += `\n**Issue Type:** {{issue_type}}  `;
      messageTemplate += `\n**Issue Status:** {{issue_status}}  `;
    }

    for (const extra of payload.extra ?? []) {
      messageTemplate += `\n\n**${extra.name}**\n${extra.value}  `;
    }

    if (applicationUrl && payload.media) {
      const actionUrl = `${applicationUrl}/${payload.media.mediaType}/${payload.media.tmdbId}`;
      const displayUrl =
        actionUrl.length > 40 ? `${actionUrl.slice(0, 41)}...` : actionUrl;
      messageTemplate += `\n\n**Open in ${applicationTitle}:** [${displayUrl}](${actionUrl})  `;
    }

    const title = TemplateEngine.render(titleTemplate, payload, type);
    const message = TemplateEngine.render(messageTemplate, payload, type);

    return {
      extras: {
        'client::display': {
          contentType: 'text/markdown',
        },
      },
      title,
      message,
      priority,
    };
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

    logger.debug('Sending Gotify notification', {
      label: 'Notifications',
      type: Notification[type],
      subject: payload.subject,
    });
    try {
      const endpoint = `${settings.options.url}/message?token=${settings.options.token}`;
      const notificationPayload = this.getNotificationPayload(type, payload);

      await axios.post(endpoint, notificationPayload);

      return true;
    } catch (e) {
      logger.error('Error sending Gotify notification', {
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

export default GotifyAgent;
