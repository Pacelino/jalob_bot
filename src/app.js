import { Telegraf, Markup } from 'telegraf';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from 'dotenv';

import { DatabaseService } from './services/DatabaseService.js';
import { AccountManager } from './services/AccountManager.js';
import { MonitorService } from './services/MonitorService.js';
import { StatsCollector } from './services/StatsCollector.js';
import { BotHandlers } from './bot/handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Загружаем конфигурацию
config({ path: join(dirname(__dirname), 'config.env') });

// Проверяем наличие обязательных переменных
if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не установлен в config.env');
  process.exit(1);
}

if (!process.env.API_ID || !process.env.API_HASH) {
  console.error('❌ API_ID и API_HASH должны быть установлены в config.env');
  process.exit(1);
}

// Инициализируем бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// Инициализируем сервисы
const db = new DatabaseService();
const accountManager = new AccountManager(db);
const statsCollector = new StatsCollector(db);
const monitorService = new MonitorService(db, accountManager, statsCollector, bot);

// Парсим разрешенных пользователей
const allowedUsers = process.env.ALLOWED_USERS 
  ? process.env.ALLOWED_USERS.split(',').map(u => u.trim())
  : [];

// Middleware для проверки прав доступа
bot.use(async (ctx, next) => {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : null;
  
  const isAllowed = allowedUsers.includes(userId) || 
                   (username && allowedUsers.includes(username)) ||
                   allowedUsers.length === 0; // Если список пуст, разрешаем всем
  
  if (!isAllowed) {
    await ctx.reply('❌ У вас нет доступа к этому боту');
    return;
  }
  
  return next();
});

// Инициализируем обработчики команд
const handlers = new BotHandlers(db, accountManager, monitorService, statsCollector);
handlers.setupHandlers(bot);

// Обработка необработанных ошибок
bot.catch((err, ctx) => {
  console.error('Необработанная ошибка в боте:', err);
  if (ctx) {
    console.error('Контекст ошибки:', {
      updateId: ctx.update?.update_id,
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
      messageText: ctx.message?.text
    });
    
    // Пытаемся отправить сообщение об ошибке пользователю
    try {
      ctx.reply('❌ Произошла внутренняя ошибка. Попробуйте позже или начните заново с /start');
    } catch (replyError) {
      console.error('Ошибка отправки сообщения об ошибке:', replyError);
    }
  }
});

// Запуск бота (поддержка webhook и корректный polling)
(async () => {
  try {
    // Опциональная задержка запуска для избежания параллельного polling при роллинге
    const startupDelayMs = parseInt(process.env.STARTUP_DELAY_MS || '0', 10);
    if (startupDelayMs > 0) {
      console.log(`⏳ Задержка запуска ${startupDelayMs} мс...`);
      await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
    }

    const domain = process.env.WEBHOOK_URL;
    const shouldUseWebhook = (!!domain) && ((process.env.USE_WEBHOOK === 'true') || !!process.env.PORT);
    if (shouldUseWebhook) {
      const hookPath = process.env.WEBHOOK_PATH || '/telegram/webhook';
      const port = parseInt(process.env.PORT || '3000', 10);

      // Настраиваем webhook
      await bot.launch({ webhook: { domain, hookPath, port } });
      console.log(`🤖 Бот запущен в режиме WEBHOOK: https://${domain}${hookPath} на порту ${port}`);
    } else {
      if (process.env.USE_WEBHOOK === 'true' && !domain) {
        console.log('⚠️ USE_WEBHOOK=true, но WEBHOOK_URL не задан. Переходим в режим POLLING.');
      }
      // На всякий случай удаляем возможный webhook и сбрасываем хвост апдейтов
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
      } catch (e) {
        console.log('⚠️ Не удалось удалить вебхук (можно игнорировать):', e.message);
      }

      await bot.launch({ dropPendingUpdates: true });
      console.log('🤖 Бот запущен в режиме POLLING');
    }

    console.log(`👥 Разрешенные пользователи: ${allowedUsers.length > 0 ? allowedUsers.join(', ') : 'все'}`);
  } catch (err) {
    console.error('❌ Ошибка запуска бота:', err);
    process.exit(1);
  }
})();

// Обработка необработанных исключений и отклонений промисов
process.on('uncaughtException', (error) => {
  console.error('Необработанное исключение:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  // Игнорируем известную проблему GramJS с resolve()
  if (reason && reason.message && reason.message.includes('resolve()') && reason.message.includes('non-request instance')) {
    // Молча игнорируем эту ошибку - она не влияет на функциональность
    return;
  }
  console.error('Необработанное отклонение промиса:', reason);
  console.error('Promise:', promise);
});

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('🛑 Получен сигнал SIGINT, останавливаем бота...');
  bot.stop('SIGINT');
  monitorService.stop().then(() => {
    console.log('✅ Бот остановлен');
    process.exit(0);
  });
});

process.once('SIGTERM', () => {
  console.log('🛑 Получен сигнал SIGTERM, останавливаем бота...');
  bot.stop('SIGTERM');
  monitorService.stop().then(() => {
    console.log('✅ Бот остановлен');
    process.exit(0);
  });
});