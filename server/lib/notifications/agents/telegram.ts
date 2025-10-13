import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { TemplateEngine } from '@server/lib/notifications/templateEngine';
import type { NotificationAgentTelegram } from '@server/lib/settings';
import { getSettings, NotificationAgentKey } from '@server/lib/settings';
import logger from '@server/logger';
import axios from 'axios';
import {
  hasNotificationType,
  Notification,
  shouldSendAdminNotification,
} from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

interface TelegramMessagePayload {
  text: string;
  parse_mode: string;
  chat_id: string;
  message_thread_id: string;
  disable_notification: boolean;
}

interface TelegramPhotoPayload {
  photo: string;
  caption: string;
  parse_mode: string;
  chat_id: string;
  message_thread_id: string;
  disable_notification: boolean;
}

class TelegramAgent
  extends BaseAgent<NotificationAgentTelegram>
  implements NotificationAgent
{
  private baseUrl = 'https://api.telegram.org/';

  protected getSettings(): NotificationAgentTelegram {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.telegram;
  }

  public shouldSend(): boolean {
    const settings = this.getSettings();

    if (settings.enabled && settings.options.botAPI) {
      return true;
    }

    return false;
  }

  private escapeText(text: string | undefined): string {
    return text ? text.replace(/[_*[\]()~>#+=|{}.!-]/gi, (x) => '\\' + x) : '';
  }

  private getNotificationPayload(
    type: Notification,
    payload: NotificationPayload
  ): Partial<TelegramMessagePayload | TelegramPhotoPayload> {
    const settings = getSettings();
    const { applicationUrl, applicationTitle } = settings.main;
    const { embedPoster } = settings.notifications.agents.telegram;

    /* eslint-disable no-useless-escape */
    let messageTemplate = payload.event
      ? `*{{event}} - {{subject}}*`
      : `*{{subject}}*`;

    if (payload.message) {
      messageTemplate += `\n{{message}}`;
    }

    if (payload.request) {
      messageTemplate += `\n\n*Requested By:* {{requestedBy_username}}`;

      let status = '';
      switch (type) {
        case Notification.MEDIA_AUTO_REQUESTED:
          status =
            payload.media?.status === MediaStatus.PENDING
              ? 'Pending Approval'
              : 'Processing';
          break;
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
        messageTemplate += `\n*Request Status:* ${status}`;
      }
    } else if (payload.comment) {
      messageTemplate += `\n\n*Comment from {{commentedBy_username}}:* {{comment_message}}`;
    } else if (payload.issue) {
      messageTemplate += `\n\n*Reported By:* {{reportedBy_username}}`;
      messageTemplate += `\n*Issue Type:* {{issue_type}}`;
      messageTemplate += `\n*Issue Status:* {{issue_status}}`;
    }

    for (const extra of payload.extra ?? []) {
      messageTemplate += `\n*${extra.name}:* ${extra.value}`;
    }

    const url = applicationUrl
      ? payload.issue
        ? `${applicationUrl}/issues/${payload.issue.id}`
        : payload.media
        ? `${applicationUrl}/${payload.media.mediaType}/${payload.media.tmdbId}`
        : undefined
      : undefined;

    if (url) {
      messageTemplate += `\n\n[View ${
        payload.issue ? 'Issue' : 'Media'
      } in ${applicationTitle}](${url})`;
    }

    // Render template first, then escape for MarkdownV2
    const renderedMessage = TemplateEngine.render(
      messageTemplate,
      payload,
      type
    );
    const message = this.escapeText(renderedMessage);
    /* eslint-enable */

    return embedPoster && payload.image
      ? {
          photo: payload.image,
          caption: message,
          parse_mode: 'MarkdownV2',
        }
      : {
          text: message,
          parse_mode: 'MarkdownV2',
        };
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    const settings = this.getSettings();
    const endpoint = `${this.baseUrl}bot${settings.options.botAPI}/${
      settings.embedPoster && payload.image ? 'sendPhoto' : 'sendMessage'
    }`;
    const notificationPayload = this.getNotificationPayload(type, payload);

    // Send system notification
    if (
      payload.notifySystem &&
      hasNotificationType(type, settings.types ?? 0) &&
      settings.options.chatId
    ) {
      logger.debug('Sending Telegram notification', {
        label: 'Notifications',
        type: Notification[type],
        subject: payload.subject,
      });

      try {
        await axios.post(endpoint, {
          ...notificationPayload,
          chat_id: settings.options.chatId,
          message_thread_id: settings.options.messageThreadId,
          disable_notification: !!settings.options.sendSilently,
        } as TelegramMessagePayload | TelegramPhotoPayload);
      } catch (e) {
        logger.error('Error sending Telegram notification', {
          label: 'Notifications',
          type: Notification[type],
          subject: payload.subject,
          errorMessage: e.message,
          response: e?.response?.data,
        });

        return false;
      }
    }

    if (payload.notifyUser) {
      if (
        payload.notifyUser.settings?.hasNotificationType(
          NotificationAgentKey.TELEGRAM,
          type
        ) &&
        payload.notifyUser.settings?.telegramChatId &&
        payload.notifyUser.settings.telegramChatId !== settings.options.chatId
      ) {
        logger.debug('Sending Telegram notification', {
          label: 'Notifications',
          recipient: payload.notifyUser.displayName,
          type: Notification[type],
          subject: payload.subject,
        });

        try {
          await axios.post(endpoint, {
            ...notificationPayload,
            chat_id: payload.notifyUser.settings.telegramChatId,
            message_thread_id:
              payload.notifyUser.settings.telegramMessageThreadId,
            disable_notification:
              !!payload.notifyUser.settings.telegramSendSilently,
          } as TelegramMessagePayload | TelegramPhotoPayload);
        } catch (e) {
          logger.error('Error sending Telegram notification', {
            label: 'Notifications',
            recipient: payload.notifyUser.displayName,
            type: Notification[type],
            subject: payload.subject,
            errorMessage: e.message,
            response: e?.response?.data,
          });

          return false;
        }
      }
    }

    if (payload.notifyAdmin) {
      const userRepository = getRepository(User);
      const users = await userRepository.find();

      await Promise.all(
        users
          .filter(
            (user) =>
              user.settings?.hasNotificationType(
                NotificationAgentKey.TELEGRAM,
                type
              ) && shouldSendAdminNotification(type, user, payload)
          )
          .map(async (user) => {
            if (
              user.settings?.telegramChatId &&
              user.settings.telegramChatId !== settings.options.chatId
            ) {
              logger.debug('Sending Telegram notification', {
                label: 'Notifications',
                recipient: user.displayName,
                type: Notification[type],
                subject: payload.subject,
              });

              try {
                await axios.post(endpoint, {
                  ...notificationPayload,
                  chat_id: user.settings.telegramChatId,
                  message_thread_id: user.settings.telegramMessageThreadId,
                  disable_notification: !!user.settings?.telegramSendSilently,
                } as TelegramMessagePayload | TelegramPhotoPayload);
              } catch (e) {
                logger.error('Error sending Telegram notification', {
                  label: 'Notifications',
                  recipient: user.displayName,
                  type: Notification[type],
                  subject: payload.subject,
                  errorMessage: e.message,
                  response: e?.response?.data,
                });

                return false;
              }
            }
          })
      );
    }

    return true;
  }
}

export default TelegramAgent;
