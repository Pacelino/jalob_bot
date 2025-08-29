import { Markup } from 'telegraf';

export class BotHandlers {
  constructor(db, accountManager, monitorService, statsCollector) {
    this.db = db;
    this.accountManager = accountManager;
    this.monitorService = monitorService;
    this.statsCollector = statsCollector;
    this.pendingAuth = new Map(); // userId -> authData
    this.apiId = parseInt(process.env.API_ID);
    this.apiHash = process.env.API_HASH;
  }

  // Универсальное экранирование Markdown-символов Telegram
  escapeMarkdown(text) {
    if (text === undefined || text === null) return '';
    return String(text).replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
  }

  setupHandlers(bot) {
    // Основное меню
    bot.start(this.handleStart.bind(this));
    bot.command('menu', this.handleStart.bind(this));
    bot.command('cancel', this.handleCancel.bind(this));
    
    // Аккаунты
    bot.action('accounts', this.handleAccounts.bind(this));
    bot.action('add_account', this.handleAddAccount.bind(this));
    bot.action('cancel_auth', this.handleCancel.bind(this));
    bot.action(/^delete_account_(.+)$/, this.handleDeleteAccount.bind(this));
    bot.action('list_accounts', this.handleListAccounts.bind(this));
    
    // Группы
    bot.action('groups', this.handleGroups.bind(this));
    bot.action('add_group', this.handleAddGroup.bind(this));
    bot.action('get_group_id', this.handleGetGroupId.bind(this));
    bot.action(/^delete_group_(.+)$/, this.handleDeleteGroup.bind(this));
    bot.action('list_groups', this.handleListGroups.bind(this));
    
    // Стоп-слова
    bot.action('stopwords', this.handleStopwords.bind(this));
    bot.action('add_stopwords', this.handleAddStopwords.bind(this));
    bot.action(/^delete_stopword_(.+)$/, this.handleDeleteStopword.bind(this));
    bot.action('list_stopwords', this.handleListStopwords.bind(this));
    bot.action('clear_stopwords', this.handleClearStopwords.bind(this));
    
    // Мониторинг
    bot.action('monitor', this.handleMonitor.bind(this));
    bot.action('start_monitoring', this.handleStartMonitoring.bind(this));
    bot.action('stop_monitoring', this.handleStopMonitoring.bind(this));
    bot.action('toggle_mode', this.handleToggleMode.bind(this));
    bot.action('monitor_status', this.handleMonitorStatus.bind(this));
    
    // Статистика
    bot.action('stats', this.handleStats.bind(this));
    bot.action('detailed_stats', this.handleDetailedStats.bind(this));
    bot.action('clear_stats', this.handleClearStats.bind(this));
    bot.action('export_stats', this.handleExportStats.bind(this));
    
    // Назад к главному меню
    bot.action('back_to_main', this.handleStart.bind(this));
    
    // Очередь жалоб
    bot.action('queue_status', this.handleQueueStatus.bind(this));
    
    // Обработка текстовых сообщений
    bot.on('text', this.handleText.bind(this));

    // Добавляем пользователя как администратора при первом использовании
    bot.use((ctx, next) => {
      if (ctx.from && ctx.from.id) {
        this.monitorService.addAdmin(ctx.from.id);
      }
      return next();
    });
  }

  async handleStart(ctx) {
    const data = this.db.read();
    const status = this.monitorService.getStatus();
    
    const message = `🤖 *Telegram Userbot Manager*

📊 *Текущий статус:*
• Аккаунты: ${status.totalAccounts} (подключено: ${status.connectedAccounts})
• Группы: ${status.monitoredGroups}
• Стоп-слова: ${status.stopwordsCount}
• Режим: ${status.mode === 'test' ? '🧪 Тест' : '🚀 Рабочий'}
• Мониторинг: ${status.isActive ? '🟢 Запущен' : '🔴 Остановлен'}

Выберите действие:`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('👥 Аккаунты', 'accounts'),
        Markup.button.callback('📢 Группы', 'groups')
      ],
      [
        Markup.button.callback('🚫 Стоп-слова', 'stopwords'),
        Markup.button.callback('📊 Статистика', 'stats')
      ],
      [
        Markup.button.callback('⚙️ Мониторинг', 'monitor')
      ]
    ]);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    } else {
      await ctx.reply(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      });
    }
  }

  async handleAccounts(ctx) {
    const data = this.db.read();
    const connectedAccounts = this.accountManager.getConnectedAccounts();
    
    let message = `👥 *Управление аккаунтами*\n\n`;
    
    if (data.accounts.length === 0) {
      message += `📱 Аккаунты не добавлены`;
    } else {
      message += `📱 *Добавленные аккаунты:*\n`;
      for (const account of data.accounts) {
        const isConnected = connectedAccounts.some(acc => acc.id === account.id);
        const status = isConnected ? '🟢' : '🔴';
        message += `${status} ${account.phone} (${account.firstName || 'Неизвестно'})\n`;
      }
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить аккаунт', 'add_account')],
      [Markup.button.callback('📋 Список аккаунтов', 'list_accounts')],
      [Markup.button.callback('🔙 Назад', 'back_to_main')]
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });
  }

  async handleAddAccount(ctx) {
    await ctx.editMessageText(
      `📱 *Добавление аккаунта*\n\nОтправьте номер телефона в формате:\n\\+79123456789\n\n❌ Для отмены нажмите кнопку ниже или отправьте /cancel`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('❌ Отменить', 'cancel_auth')],
          [Markup.button.callback('🔙 Назад', 'accounts')]
        ]).reply_markup
      }
    );

    // Устанавливаем состояние ожидания номера телефона
    this.pendingAuth.set(ctx.from.id, { step: 'phone' });
  }

  async handleListAccounts(ctx) {
    const data = this.db.read();
    
    if (data.accounts.length === 0) {
      await ctx.editMessageText(
        `📱 *Список аккаунтов*\n\nАккаунты не добавлены`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', 'accounts')]
          ]).reply_markup
        }
      );
      return;
    }

    let message = `📱 *Список аккаунтов*\n\n`;
    const buttons = [];
    
    for (const account of data.accounts) {
      const displayName = `${account.phone} (${account.firstName || 'Неизвестно'})`;
      message += `• ${displayName}\n`;
      buttons.push([Markup.button.callback(`🗑 ${account.phone}`, `delete_account_${account.id}`)]);
    }

    buttons.push([Markup.button.callback('🔙 Назад', 'accounts')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup
    });
  }

  async handleDeleteAccount(ctx) {
    const accountId = ctx.match[1];
    const data = this.db.read();
    const account = data.accounts.find(acc => acc.id === accountId);
    
    if (!account) {
      await ctx.answerCbQuery('Аккаунт не найден');
      return;
    }

    const result = await this.accountManager.removeAccount(accountId);
    
    if (result.success) {
      await ctx.answerCbQuery(`Аккаунт ${account.phone} удален`);
      await this.handleListAccounts(ctx);
    } else {
      await ctx.answerCbQuery(`Ошибка: ${result.error}`);
    }
  }

  // Отмена текущего процесса добавления/авторизации аккаунта
  async handleCancel(ctx) {
    const userId = ctx.from.id;
    const authData = this.pendingAuth.get(userId);
    if (!authData) {
      if (ctx.updateType === 'callback_query') {
        await ctx.answerCbQuery('Нет активного процесса');
        await this.handleAccounts(ctx);
      } else {
        await ctx.reply('Нет активного процесса добавления аккаунта');
      }
      return;
    }

    try {
      if (authData.timeout) {
        clearTimeout(authData.timeout);
      }
      // Отклоняем ожидающий промис, чтобы client.start() завершился
      if (authData.reject) {
        authData.reject(new Error('Отменено пользователем'));
      }
      // Пытаемся безопасно остановить временный клиент
      if (authData.accountId) {
        await this.accountManager.abortPendingClient(authData.accountId);
      }
    } catch (e) {
      console.error('Ошибка при отмене авторизации:', e);
    } finally {
      this.pendingAuth.delete(userId);
    }

    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery('Процесс отменен');
      await this.handleAccounts(ctx);
    } else {
      await ctx.reply('✅ Отменено. Возвращаюсь в меню аккаунтов.');
      // Покажем меню аккаунтов, если можем
      try { await this.handleAccounts(ctx); } catch {}
    }
  }

  async handleGroups(ctx) {
    const data = this.db.read();
    
    let message = `📢 *Управление группами*\n\n`;
    
    if (data.groups.length === 0) {
      message += `📢 Группы не добавлены`;
    } else {
      message += `📢 *Отслеживаемые группы:*\n`;
      for (const group of data.groups) {
        message += `• ${this.escapeMarkdown(group)}\n`;
      }
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить группу', 'add_group')],
      [Markup.button.callback('🔍 Получить ID группы', 'get_group_id')],
      [Markup.button.callback('📋 Список групп', 'list_groups')],
      [Markup.button.callback('🔙 Назад', 'back_to_main')]
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });
  }

  async handleAddGroup(ctx) {
    await ctx.editMessageText(
      `📢 *Добавление группы*\n\nОтправьте username группы или ID:\n\\@channel\\_name или \\-1001234567890`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад', 'groups')]
        ]).reply_markup
      }
    );

    this.pendingAuth.set(ctx.from.id, { step: 'group' });
  }

  async handleGetGroupId(ctx) {
    await ctx.editMessageText(
      `🔍 *Получение ID группы*\n\nОтправьте username группы для получения её реального ID:\n\\@channel\\_name`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад', 'groups')]
        ]).reply_markup
      }
    );

    this.pendingAuth.set(ctx.from.id, { step: 'get_group_id' });
  }

  async handleListGroups(ctx) {
    const data = this.db.read();
    
    if (data.groups.length === 0) {
      await ctx.editMessageText(
        `📢 *Список групп*\n\nГруппы не добавлены`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', 'groups')]
          ]).reply_markup
        }
      );
      return;
    }

    let message = `📢 *Список групп*\n\n`;
    const buttons = [];
    
    for (const group of data.groups) {
      message += `• ${this.escapeMarkdown(group)}\n`;
      const encodedGroup = encodeURIComponent(group);
      buttons.push([Markup.button.callback(`🗑 ${group}`, `delete_group_${encodedGroup}`)]);
    }

    buttons.push([Markup.button.callback('🔙 Назад', 'groups')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup
    });
  }

  async handleDeleteGroup(ctx) {
    const groupId = decodeURIComponent(ctx.match[1]);
    
    await this.db.removeGroup(groupId);
    await ctx.answerCbQuery(`Группа ${groupId} удалена`);
    await this.handleListGroups(ctx);
  }

  async handleStopwords(ctx) {
    const data = this.db.read();
    
    let message = `🚫 *Управление стоп-словами*\n\n`;
    
    if (data.stopwords.length === 0) {
      message += `🚫 Стоп-слова не добавлены`;
    } else {
      message += `🚫 *Стоп-слова (${data.stopwords.length}):*\n`;
      const preview = data.stopwords.slice(0, 10);
      for (const word of preview) {
        message += `• ${this.escapeMarkdown(word)}\n`;
      }
      if (data.stopwords.length > 10) {
        message += `... и еще ${data.stopwords.length - 10}`;
      }
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить стоп-слова', 'add_stopwords')],
      [Markup.button.callback('📋 Список стоп-слов', 'list_stopwords')],
      [Markup.button.callback('🗑 Очистить все', 'clear_stopwords')],
      [Markup.button.callback('🔙 Назад', 'back_to_main')]
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });
  }

  async handleAddStopwords(ctx) {
    await ctx.editMessageText(
      `🚫 *Добавление стоп-слов*\n\nОтправьте стоп-слова (каждое с новой строки или через запятую):\nрекламa\nспам\nпродам`,
      {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Назад', 'stopwords')]
        ]).reply_markup
      }
    );

    this.pendingAuth.set(ctx.from.id, { step: 'stopwords' });
  }

  async handleListStopwords(ctx) {
    const data = this.db.read();
    
    if (data.stopwords.length === 0) {
      await ctx.editMessageText(
        `🚫 *Список стоп-слов*\n\nСтоп-слова не добавлены`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', 'stopwords')]
          ]).reply_markup
        }
      );
      return;
    }

    // Разбиваем на страницы по 10 слов
    const wordsPerPage = 10;
    const totalPages = Math.ceil(data.stopwords.length / wordsPerPage);
    
    let message = `🚫 *Список стоп-слов* (всего: ${data.stopwords.length})\n\n`;
    const buttons = [];
    
    for (let i = 0; i < Math.min(wordsPerPage, data.stopwords.length); i++) {
      const word = data.stopwords[i];
      message += `• ${this.escapeMarkdown(word)}\n`;
      buttons.push([Markup.button.callback(`🗑 ${word}`, `delete_stopword_${encodeURIComponent(word)}`)]);
    }

    if (data.stopwords.length > wordsPerPage) {
      message += `\n... показаны первые ${wordsPerPage} из ${data.stopwords.length}`;
    }

    buttons.push([Markup.button.callback('🔙 Назад', 'stopwords')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup
    });
  }

  async handleDeleteStopword(ctx) {
    const word = decodeURIComponent(ctx.match[1]);
    
    await this.db.removeStopwords([word]);
    await ctx.answerCbQuery(`Стоп-слово "${word}" удалено`);
    await this.handleListStopwords(ctx);
  }

  async handleClearStopwords(ctx) {
    const data = this.db.read();
    
    if (data.stopwords.length === 0) {
      await ctx.answerCbQuery('Список стоп-слов уже пуст');
      return;
    }

    await this.db.removeStopwords(data.stopwords);
    await ctx.answerCbQuery(`Удалены все стоп-слова (${data.stopwords.length} шт.)`);
    await this.handleStopwords(ctx);
  }

  async handleMonitor(ctx) {
    const status = this.monitorService.getStatus();
    
    const message = `⚙️ *Управление мониторингом*

📊 *Текущий статус:*
• Мониторинг: ${status.isActive ? '🟢 Запущен' : '🔴 Остановлен'}
• Режим: ${status.mode === 'test' ? '🧪 Тест-режим' : '🚀 Рабочий режим'}
• Подключено аккаунтов: ${status.connectedAccounts}/${status.totalAccounts}
• Отслеживается групп: ${status.monitoredGroups}
• Стоп-слов: ${status.stopwordsCount}

${status.mode === 'test' ? '📝 В тест-режиме жалобы не отправляются' : '⚡ В рабочем режиме жалобы отправляются автоматически'}`;

    const buttons = [];
    
    if (status.isActive) {
      buttons.push([Markup.button.callback('⏹ Остановить мониторинг', 'stop_monitoring')]);
    } else {
      buttons.push([Markup.button.callback('▶️ Запустить мониторинг', 'start_monitoring')]);
    }
    
    buttons.push([Markup.button.callback('🔄 Переключить режим', 'toggle_mode')]);
    buttons.push([Markup.button.callback('📊 Статус', 'monitor_status')]);
    buttons.push([Markup.button.callback('📋 Очередь жалоб', 'queue_status')]);
    buttons.push([Markup.button.callback('🔙 Назад', 'back_to_main')]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup
    });
  }

  async handleStartMonitoring(ctx) {
    const result = await this.monitorService.start();
    
    if (result.success) {
      await ctx.answerCbQuery(`Мониторинг запущен (${result.connectedAccounts} аккаунтов)`);
    } else {
      await ctx.answerCbQuery(`Ошибка: ${result.message || result.error}`);
    }
    
    await this.handleMonitor(ctx);
  }

  async handleStopMonitoring(ctx) {
    const result = await this.monitorService.stop();
    
    if (result.success) {
      await ctx.answerCbQuery('Мониторинг остановлен');
    } else {
      await ctx.answerCbQuery(`Ошибка: ${result.message || result.error}`);
    }
    
    await this.handleMonitor(ctx);
  }

  async handleToggleMode(ctx) {
    const data = this.db.read();
    const newMode = data.mode === 'test' ? 'run' : 'test';
    
    await this.db.setMode(newMode);
    
    const modeText = newMode === 'test' ? 'тест-режим' : 'рабочий режим';
    await ctx.answerCbQuery(`Режим изменен на: ${modeText}`);
    await this.handleMonitor(ctx);
  }

  async handleMonitorStatus(ctx) {
    const status = this.monitorService.getStatus();
    
    const message = `📊 *Подробный статус мониторинга*

🔧 *Настройки:*
• Аккаунты: ${status.totalAccounts} добавлено
• Подключено: ${status.connectedAccounts}
• Группы: ${status.monitoredGroups}
• Стоп-слова: ${status.stopwordsCount}
• Режим: ${status.mode === 'test' ? '🧪 Тест' : '🚀 Рабочий'}

⚡ *Мониторинг:* ${status.isActive ? '🟢 Активен' : '🔴 Неактивен'}

${status.connectedAccounts === 0 ? '⚠️ Нет подключенных аккаунтов' : ''}
${status.monitoredGroups === 0 ? '⚠️ Нет групп для мониторинга' : ''}
${status.stopwordsCount === 0 ? '⚠️ Нет стоп-слов для поиска' : ''}`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад', 'monitor')]
      ]).reply_markup
    });
  }

  async handleStats(ctx) {
    const totalStats = this.statsCollector.getTotalStats();
    const topWords = this.statsCollector.getTopWords(5);
    const topGroups = this.statsCollector.getTopGroups(5);
    
    let message = `📊 *Статистика*

📈 *Общая статистика:*
• Всего срабатываний: ${totalStats.totalHits}
• Уникальных слов: ${totalStats.totalWords}
• Активных групп: ${totalStats.totalGroups}

`;

    if (topWords.length > 0) {
      message += `🔥 *Топ стоп-слов:*\n`;
      for (const item of topWords) {
        message += `• ${this.escapeMarkdown(item.word)}: ${item.count}\n`;
      }
      message += '\n';
    }

    if (topGroups.length > 0) {
      message += `📢 *Топ групп:*\n`;
      for (const item of topGroups) {
        message += `• ${this.escapeMarkdown(item.group)}: ${item.count}\n`;
      }
    }

    if (totalStats.totalHits === 0) {
      message += `📭 Статистика пуста`;
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📋 Подробная статистика', 'detailed_stats')],
      [
        Markup.button.callback('🗑 Очистить', 'clear_stats'),
        Markup.button.callback('📤 Экспорт', 'export_stats')
      ],
      [Markup.button.callback('🔙 Назад', 'back_to_main')]
    ]);

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });
  }

  async handleDetailedStats(ctx) {
    const formattedStats = this.statsCollector.getFormattedStats();
    
    if (formattedStats.length === 0) {
      await ctx.editMessageText(
        `📊 *Подробная статистика*\n\nСтатистика пуста`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Назад', 'stats')]
          ]).reply_markup
        }
      );
      return;
    }

    let message = `📊 *Подробная статистика*\n\n`;
    
    // Показываем первые 20 записей
    const limit = 20;
    for (let i = 0; i < Math.min(limit, formattedStats.length); i++) {
      const stat = formattedStats[i];
      message += `• ${this.escapeMarkdown(stat.group)} | ${this.escapeMarkdown(stat.word)}: ${stat.count}\n`;
    }
    
    if (formattedStats.length > limit) {
      message += `\n... и еще ${formattedStats.length - limit} записей`;
    }

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад', 'stats')]
      ]).reply_markup
    });
  }

  async handleClearStats(ctx) {
    const result = await this.statsCollector.clearStats();
    
    if (result) {
      await ctx.answerCbQuery('Статистика очищена');
    } else {
      await ctx.answerCbQuery('Ошибка очистки статистики');
    }
    
    await this.handleStats(ctx);
  }

  async handleExportStats(ctx) {
    const exportData = this.statsCollector.exportStats();
    
    if (exportData.totalStats.totalHits === 0) {
      await ctx.answerCbQuery('Нет данных для экспорта');
      return;
    }

    const jsonData = JSON.stringify(exportData, null, 2);
    
    try {
      await ctx.replyWithDocument({
        source: Buffer.from(jsonData, 'utf8'),
        filename: `stats_${new Date().toISOString().split('T')[0]}.json`
      }, {
        caption: 'Экспорт статистики в формате JSON'
      });
      
      await ctx.answerCbQuery('Статистика экспортирована');
    } catch (error) {
      console.error('Ошибка экспорта статистики:', error);
      await ctx.answerCbQuery('Ошибка экспорта статистики');
    }
  }

  async handleText(ctx) {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const authData = this.pendingAuth.get(userId);
    
    console.log(`handleText вызван для пользователя ${userId}, текст: "${text}"`);
    console.log(`Состояние pendingAuth:`, authData ? authData.step : 'нет данных');
    
    if (!authData) {
      console.log(`Нет ожидаемого ввода для пользователя ${userId}, игнорируем`);
      return; // Игнорируем сообщения, если нет ожидаемого ввода
    }

    try {
      // Команда отмены в любом шаге авторизации
      if (text.trim().toLowerCase() === '/cancel') {
        await this.handleCancel(ctx);
        return;
      }
      // Улучшенная логика для обработки кода и пароля
      if (authData.step === 'waiting_code') {
        console.log(`Получен код от пользователя ${userId}: ${text}`);
        // Очищаем таймаут
        if (authData.timeout) {
          clearTimeout(authData.timeout);
        }
        
        // Валидируем код (обычно 5-7 цифр)
        const cleanCode = text.replace(/[^0-9]/g, ''); // Убираем все нецифровые символы
        console.log(`Очищенный код: ${cleanCode}`);
        
        if (cleanCode.length < 4 || cleanCode.length > 7) {
          await ctx.reply('❌ Неверный формат кода. Код должен содержать 4-7 цифр. Попробуйте снова:');
          // Восстанавливаем таймаут
          authData.timeout = setTimeout(() => {
            authData.reject(new Error('Таймаут ожидания кода (5 минут)'));
            this.pendingAuth.delete(userId);
          }, 300000);
          return;
        }
        
        console.log(`Передаем код в resolve: ${cleanCode}`);
        // Передаем очищенный код в промис
        authData.resolve(cleanCode);
        return;
      }
      
      if (authData.step === 'waiting_password') {
        console.log(`Получен пароль от пользователя ${userId}`);
        // Очищаем таймаут
        if (authData.timeout) {
          clearTimeout(authData.timeout);
        }
        
        // Проверяем, что пароль не пустой
        if (!text.trim()) {
          await ctx.reply('❌ Пароль не может быть пустым. Введите облачный пароль (2FA):');
          // Восстанавливаем таймаут
          authData.timeout = setTimeout(() => {
            authData.reject(new Error('Таймаут ожидания пароля (5 минут)'));
            this.pendingAuth.delete(userId);
          }, 300000);
          return;
        }
        
        console.log(`Передаем пароль в resolve`);
        // Передаем пароль в промис
        authData.resolve(text.trim());
        return;
      }
      
      // Старые обработчики для других шагов
      if (authData.step === 'phone') {
        await this.handlePhoneInput(ctx, text);
      } else if (authData.step === 'group') {
        await this.handleGroupInput(ctx, text);
      } else if (authData.step === 'get_group_id') {
        await this.handleGetGroupIdInput(ctx, text);
      } else if (authData.step === 'stopwords') {
        await this.handleStopwordsInput(ctx, text);
      }
    } catch (error) {
      console.error('Ошибка обработки текста:', error);
      await ctx.reply(`Ошибка: ${error.message}`);
      this.pendingAuth.delete(userId);
    }
  }

  async handlePhoneInput(ctx, phone) {
    const userId = ctx.from.id;
    
    // Проверяем формат номера
    if (!phone.match(/^\+?[1-9]\d{10,14}$/)) {
      await ctx.reply('❌ Неверный формат номера. Используйте формат: +79123456789');
      return;
    }

    // Проверяем, не добавлен ли уже этот номер
    const data = this.db.read();
    const existingAccount = data.accounts.find(acc => acc.phone === phone);
    if (existingAccount) {
      await ctx.reply('❌ Аккаунт с таким номером уже добавлен');
      this.pendingAuth.delete(userId);
      return;
    }

    try {
      await ctx.reply('🔄 Создаем клиент и подключаемся к Telegram...');
      
      console.log(`Создание клиента для номера: ${phone}`);
      const { client, accountId } = await this.accountManager.createClient(phone);
      console.log(`Клиент создан успешно для номера: ${phone}, accountId: ${accountId}`);
      
      // Сохраняем данные авторизации
      this.pendingAuth.set(userId, {
        step: 'starting_auth',
        phone,
        accountId,
        client
      });

      // Запускаем процесс авторизации используя client.start()
      await this.startTelegramAuth(ctx, client, phone, accountId);
      
    } catch (error) {
      console.error('Ошибка создания клиента:', error);
      
      let errorMessage = error.message;
      if (error.message.includes('PHONE_NUMBER_BANNED')) {
        errorMessage = 'Номер телефона заблокирован в Telegram';
      } else if (error.message.includes('PHONE_NUMBER_INVALID')) {
        errorMessage = 'Неверный номер телефона';
      } else if (error.message.includes('PHONE_NUMBER_FLOOD')) {
        errorMessage = 'Слишком много попыток. Попробуйте позже';
      } else if (error.message.includes('API_ID_INVALID')) {
        errorMessage = 'Неверные API_ID/API_HASH в конфигурации';
      }
      
      await ctx.reply(`❌ Ошибка создания клиента: ${errorMessage}`);
      this.pendingAuth.delete(userId);
    }
  }



  async handleGetGroupIdInput(ctx, groupInput) {
    const userId = ctx.from.id;
    
    try {
      console.log(`Получение ID группы от пользователя ${userId}: "${groupInput}"`);
      
      let normalizedGroupId = groupInput.trim();
      
      // Извлекаем username из URL если это ссылка t.me
      if (normalizedGroupId.includes('t.me/')) {
        const match = normalizedGroupId.match(/t\.me\/([^/?]+)/);
        if (match) {
          normalizedGroupId = match[1];
        }
      }
      
      // Убираем @ если есть
      if (normalizedGroupId.startsWith('@')) {
        normalizedGroupId = normalizedGroupId.substring(1);
      }
      
      // Получаем первый доступный аккаунт для запроса
      const accounts = this.accountManager.getConnectedAccounts();
      if (accounts.length === 0) {
        await ctx.reply('❌ Нет подключенных аккаунтов для получения ID группы');
        this.pendingAuth.delete(userId);
        return;
      }
      
      const client = this.accountManager.getClient(accounts[0].id);
      if (!client) {
        await ctx.reply('❌ Не удалось получить клиент для запроса');
        this.pendingAuth.delete(userId);
        return;
      }
      
      await ctx.reply('🔍 Получаем информацию о группе...');
      
      // Пытаемся получить информацию о группе
      try {
        const entity = await client.getEntity(normalizedGroupId);
        
        // Получаем правильный ID чата для супергрупп/каналов
        let realId;
        if (entity.id) {
          // Для супергрупп и каналов нужно добавить префикс -100
          if (entity.className === 'Channel' || entity.megagroup) {
            realId = `-100${entity.id}`;
          } else {
            realId = entity.id.toString();
          }
        } else if (entity.chatId) {
          realId = entity.chatId.toString();
        } else {
          realId = 'Неизвестно';
        }
        
        const safeUsername = this.escapeMarkdown(normalizedGroupId);
        const safeTitle = this.escapeMarkdown(entity.title || '');
        await ctx.reply(`✅ Информация о группе @${safeUsername}:\n\n🆔 **Полный ID**: \`${realId}\`\n🆔 **Внутренний ID**: \`${entity.id}\`\n📛 **Название**: ${safeTitle}\n👥 **Участников**: ${entity.participantsCount || 'Неизвестно'}\n🏷 **Тип**: ${this.escapeMarkdown(entity.className)}${entity.megagroup ? ' (мегагруппа)' : ''}`, {
          parse_mode: 'Markdown'
        });
        
      } catch (entityError) {
        console.error('Ошибка получения информации о группе:', entityError);
        await ctx.reply(`❌ Не удалось получить информацию о группе @${normalizedGroupId}.\n\nВозможные причины:\n• Группа не существует\n• Группа приватная\n• Аккаунт не состоит в группе\n\nОшибка: ${entityError.message}`);
      }
      
      this.pendingAuth.delete(userId);
      
    } catch (error) {
      console.error('Ошибка получения ID группы:', error);
      await ctx.reply(`❌ Ошибка получения ID группы: ${error.message}`);
      this.pendingAuth.delete(userId);
    }
  }

  async handleGroupInput(ctx, groupInput) {
    const userId = ctx.from.id;
    
    try {
      console.log(`Обработка ввода группы от пользователя ${userId}: "${groupInput}"`);
      let normalizedGroupId = groupInput.trim();
      
      // Извлекаем username из URL если это ссылка t.me
      if (normalizedGroupId.includes('t.me/')) {
        const match = normalizedGroupId.match(/t\.me\/([^/?]+)/);
        if (match) {
          normalizedGroupId = match[1];
          console.log(`Извлечен username из URL: ${normalizedGroupId}`);
        }
      }
      
      // Нормализуем ID группы
      if (!normalizedGroupId.startsWith('@') && !normalizedGroupId.match(/^-?\d+$/)) {
        normalizedGroupId = '@' + normalizedGroupId;
      }
      
      console.log(`Нормализованный ID группы: "${normalizedGroupId}"`);

      // Проверяем, не добавлена ли уже эта группа
      const data = this.db.read();
      if (data.groups.includes(normalizedGroupId)) {
        await ctx.reply('❌ Группа уже добавлена');
        this.pendingAuth.delete(userId);
        return;
      }

      console.log(`Добавляем группу в базу данных: ${normalizedGroupId}`);
      await this.db.addGroup(normalizedGroupId);
      
      // Экранируем специальные символы для безопасного отображения
      const safeGroupId = normalizedGroupId.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
      await ctx.reply(`✅ Группа ${safeGroupId} добавлена в мониторинг`);
      
      this.pendingAuth.delete(userId);
      console.log(`Группа успешно добавлена: ${normalizedGroupId}`);
      
    } catch (error) {
      console.error('Ошибка добавления группы:', error);
      await ctx.reply(`❌ Ошибка добавления группы: ${error.message}`);
      this.pendingAuth.delete(userId);
    }
  }

  async handleStopwordsInput(ctx, wordsInput) {
    const userId = ctx.from.id;
    
    try {
      // Разделяем по строкам или запятым
      const words = wordsInput
        .split(/[,\n\r]+/)
        .map(word => word.trim().toLowerCase())
        .filter(word => word.length > 0);

      if (words.length === 0) {
        await ctx.reply('❌ Не указано ни одного стоп-слова');
        this.pendingAuth.delete(userId);
        return;
      }

      // Проверяем на дубликаты
      const data = this.db.read();
      const existingWords = data.stopwords.map(word => word.toLowerCase());
      const newWords = words.filter(word => !existingWords.includes(word));

      if (newWords.length === 0) {
        await ctx.reply('❌ Все указанные стоп-слова уже добавлены');
        this.pendingAuth.delete(userId);
        return;
      }

      await this.db.addStopwords(newWords);
      
      let message = `✅ Добавлено ${newWords.length} стоп-слов:\n`;
      for (const word of newWords) {
        message += `• ${word}\n`;
      }
      
      if (words.length > newWords.length) {
        message += `\n⚠️ ${words.length - newWords.length} слов уже были добавлены ранее`;
      }

      await ctx.reply(message);
      this.pendingAuth.delete(userId);
      
    } catch (error) {
      console.error('Ошибка добавления стоп-слов:', error);
      await ctx.reply(`❌ Ошибка добавления стоп-слов: ${error.message}`);
      this.pendingAuth.delete(userId);
    }
  }

  async handleQueueStatus(ctx) {
    const queueStatus = this.monitorService.getQueueStatus();
    
    let message = `📋 *Статус очереди жалоб*\n\n`;
    
    message += `📊 *Общая информация:*\n`;
    message += `• Жалоб в очереди: ${queueStatus.queueLength}\n`;
    message += `• Обработка: ${queueStatus.isProcessing ? '🟢 Активна' : '🔴 Неактивна'}\n\n`;
    
    if (Object.keys(queueStatus.accountStats).length > 0) {
      message += `👥 *Статистика по аккаунтам:*\n`;
      
      for (const [accountId, stats] of Object.entries(queueStatus.accountStats)) {
        const statusIcon = stats.canSendMore ? '🟢' : '🔴';
        message += `${statusIcon} \`${accountId.substring(0, 8)}...\`\n`;
        message += `   • За час: ${stats.reportsThisHour}/${this.monitorService.maxReportsPerHour}\n`;
        message += `   • За день: ${stats.reportsToday}/${this.monitorService.maxReportsPerDay}\n`;
      }
    } else {
      message += `📭 Нет статистики по аккаунтам`;
    }
    
    message += `\n⚙️ *Настройки защиты:*\n`;
    message += `• Задержка: ${Math.round(this.monitorService.reportDelayMin/1000)}-${Math.round(this.monitorService.reportDelayMax/1000)} сек\n`;
    message += `• Лимит в час: ${this.monitorService.maxReportsPerHour}\n`;
    message += `• Лимит в день: ${this.monitorService.maxReportsPerDay}`;

    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад', 'monitor')]
      ]).reply_markup
    });
  }

  // Исправленный метод для авторизации через client.start()  
  async startTelegramAuth(ctx, client, phone, accountId) {
    const userId = ctx.from.id;
    
    try {
      await ctx.reply(`🔄 Запускаем авторизацию для номера ${phone}...`);
      
      // Используем правильный подход с единым вызовом client.start()
      const result = await client.start({
        phoneNumber: async () => {
          return phone;
        },
        phoneCode: async () => {
          console.log(`Запрашиваем код для номера: ${phone}`);
          await ctx.reply('📨 Введите код подтверждения (пришел в SMS или Telegram). Для отмены — /cancel');
          
          // Ждем ввод кода от пользователя
          return new Promise((resolve, reject) => {
            console.log(`Устанавливаем ожидание кода для пользователя: ${userId}`);
            // Сохраняем резолвер для обработки ввода
            this.pendingAuth.set(userId, {
              step: 'waiting_code',
              phone,
              accountId,
              client,
              resolve,
              reject,
              timeout: setTimeout(() => {
                console.log(`Таймаут ожидания кода для пользователя: ${userId}`);
                reject(new Error('Таймаут ожидания кода (5 минут)'));
                this.pendingAuth.delete(userId);
              }, 300000) // 5 минут
            });
          });
        },
        password: async () => {
          console.log(`Запрашиваем облачный пароль для номера: ${phone}`);
          await ctx.reply('🔐 Введите облачный пароль (2FA). Для отмены — /cancel');
          
          // Ждем ввод пароля от пользователя
          return new Promise((resolve, reject) => {
            console.log(`Устанавливаем ожидание пароля для пользователя: ${userId}`);
            // Сохраняем резолвер для обработки ввода
            this.pendingAuth.set(userId, {
              step: 'waiting_password',
              phone,
              accountId,
              client,
              resolve,
              reject,
              timeout: setTimeout(() => {
                console.log(`Таймаут ожидания пароля для пользователя: ${userId}`);
                reject(new Error('Таймаут ожидания пароля (5 минут)'));
                this.pendingAuth.delete(userId);
              }, 300000) // 5 минут
            });
          });
        },
        onError: (err) => {
          console.error(`Ошибка авторизации: ${err.message}`);
          // При ошибке также очищаем состояние
          const authData = this.pendingAuth.get(userId);
          if (authData && authData.timeout) {
            clearTimeout(authData.timeout);
          }
          this.pendingAuth.delete(userId);
        }
      });

      console.log('Авторизация успешна для номера:', phone, 'Результат:', result);
      
      // КРИТИЧНО: Обязательно сохраняем сессию СРАЗУ после успешной авторизации
      console.log('Сохраняем сессию для аккаунта:', accountId);
      this.accountManager.saveSession(accountId, client.session);
      
      // Получаем информацию о пользователе
      console.log('Получаем информацию о пользователе...');
      const me = await client.getMe();
      console.log('Информация о пользователе получена:', me.firstName, me.username);
      
      // Сохраняем в базу данных
      const accountData = {
        id: accountId,
        phone: phone,
        sessionFile: this.accountManager.getSessionPath(accountId),
        userId: me.id?.toString(),
        username: me.username,
        firstName: me.firstName,
        lastName: me.lastName,
        addedAt: new Date().toISOString()
      };

      await this.db.addAccount(accountData);
      
      await ctx.reply(`✅ Аккаунт ${phone} успешно добавлен!\n\nИмя: ${me.firstName} ${me.lastName || ''}\nUsername: ${me.username || 'не указан'}`);
      
      // Очищаем состояние авторизации
      this.pendingAuth.delete(userId);
      
    } catch (error) {
      console.error('Ошибка процесса авторизации:', error);
      
      // Очищаем таймаут при ошибке
      const authData = this.pendingAuth.get(userId);
      if (authData && authData.timeout) {
        clearTimeout(authData.timeout);
      }
      
      let errorMessage = error.message;
      
      // Обрабатываем специфичные ошибки Telegram API
      if (error.message.includes('PHONE_CODE_EXPIRED')) {
        errorMessage = 'Код подтверждения истек. Попробуйте добавить аккаунт заново.';
      } else if (error.message.includes('PHONE_CODE_INVALID')) {
        errorMessage = 'Неверный код подтверждения. Проверьте код и попробуйте снова.';
      } else if (error.message.includes('PASSWORD_HASH_INVALID')) {
        errorMessage = 'Неверный облачный пароль. Попробуйте снова.';
      } else if (error.message.includes('SESSION_PASSWORD_NEEDED')) {
        errorMessage = 'Требуется облачный пароль (2FA). Проверьте настройки безопасности.';
      } else if (error.message.includes('AUTH_KEY_UNREGISTERED')) {
        errorMessage = 'Сессия была сброшена. Попробуйте добавить аккаунт заново.';
      }
      
      await ctx.reply(`❌ Ошибка авторизации: ${errorMessage}`);
      this.pendingAuth.delete(userId);
    }
  }


}