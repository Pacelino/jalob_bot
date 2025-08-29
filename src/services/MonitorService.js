import { Api, TelegramClient } from 'telegram';

export class MonitorService {
  constructor(db, accountManager, statsCollector, bot) {
    this.db = db;
    this.accountManager = accountManager;
    this.statsCollector = statsCollector;
    this.bot = bot;
    this.isActive = false;
    this.eventHandlers = new Map(); // accountId -> eventHandler
    this.reconnectAttempts = new Map(); // accountId -> attempts count
    this.reconnectTimeouts = new Map(); // accountId -> timeout id
    this.adminUsers = new Set(); // Пользователи, которые получают уведомления
    
    // Периодический мониторинг
    this.periodicMonitor = null;
    this.lastMessageIds = new Map(); // groupId -> lastMessageId
    this.monitorInterval = 45000; // 45 секунд между проверками
    
    // Защита от блокировки
    this.reportQueue = []; // Очередь жалоб для отправки
    this.reportHistory = new Map(); // accountId -> array of timestamps
    this.isProcessingQueue = false;
    this.queueProcessor = null;
    
    // Настройки лимитов
    this.reportDelayMin = parseInt(process.env.REPORT_DELAY_MIN) || 60000; // 1 минута
    this.reportDelayMax = parseInt(process.env.REPORT_DELAY_MAX) || 180000; // 3 минуты
    this.maxReportsPerHour = parseInt(process.env.MAX_REPORTS_PER_HOUR) || 10;
    this.maxReportsPerDay = parseInt(process.env.MAX_REPORTS_PER_DAY) || 50;
    
    this.startQueueProcessor();
  }

  async start() {
    if (this.isActive) {
      console.log('⚠️ Мониторинг уже запущен');
      return { success: false, message: 'Мониторинг уже запущен' };
    }

    try {
      // Подключаем все аккаунты
      const connectionResults = await this.accountManager.connectAllAccounts();
      
      // Проверяем есть ли подключенные аккаунты
      const connectedAccounts = connectionResults.filter(r => r.status === 'connected');
      if (connectedAccounts.length === 0) {
        return { success: false, message: 'Нет подключенных аккаунтов' };
      }

      // Добавляем обработчики событий для каждого аккаунта
      for (const account of this.accountManager.getConnectedAccounts()) {
        await this.addEventHandler(account.id);
      }

      this.isActive = true;
      console.log('🟢 Мониторинг запущен');
      
      // Запускаем периодический мониторинг
      this.startPeriodicMonitoring();
      
      // Уведомляем администраторов через бота
      this.notifyAdmins(`🟢 Мониторинг запущен\nПодключенных аккаунтов: ${connectedAccounts.length}`);

      return { success: true, connectedAccounts: connectedAccounts.length };
    } catch (error) {
      console.error('Ошибка запуска мониторинга:', error);
      return { success: false, error: error.message };
    }
  }

  async stop() {
    if (!this.isActive) {
      console.log('⚠️ Мониторинг уже остановлен');
      return { success: false, message: 'Мониторинг уже остановлен' };
    }

    try {
      // Удаляем все обработчики событий
      for (const [accountId, handler] of this.eventHandlers) {
        const client = this.accountManager.getClient(accountId);
        if (client) {
          client.removeEventHandler(handler);
        }
      }
      this.eventHandlers.clear();

      // Очищаем таймауты переподключения
      for (const timeoutId of this.reconnectTimeouts.values()) {
        clearTimeout(timeoutId);
      }
      this.reconnectTimeouts.clear();
      this.reconnectAttempts.clear();
      
      // Останавливаем процессор очереди
      if (this.queueProcessor) {
        clearInterval(this.queueProcessor);
        this.queueProcessor = null;
      }
      
      // Останавливаем периодический мониторинг
      if (this.periodicMonitor) {
        clearInterval(this.periodicMonitor);
        this.periodicMonitor = null;
        console.log('🔴 Периодический мониторинг остановлен');
      }

      this.isActive = false;
      console.log('🔴 Мониторинг остановлен');
      
      // Уведомляем администраторов через бота
      this.notifyAdmins('🔴 Мониторинг остановлен');

      return { success: true };
    } catch (error) {
      console.error('Ошибка остановки мониторинга:', error);
      return { success: false, error: error.message };
    }
  }

  async addEventHandler(accountId) {
    const client = this.accountManager.getClient(accountId);
    if (!client) {
      console.error(`Клиент для аккаунта ${accountId} не найден`);
      return;
    }

    const eventHandler = async (event) => {
      try {
        console.log(`🔔 Получено событие для аккаунта ${accountId}:`, {
          type: event?.constructor?.name,
          hasMessage: !!event?.message,
          messageText: event?.message?.text?.substring(0, 30)
        });
        
        // Проверяем, что это действительно новое сообщение
        if (!event || !event.message) {
          console.log('❌ Событие не содержит сообщения, пропускаем');
          return;
        }
        
        await this.handleNewMessage(event, accountId);
      } catch (error) {
        console.error(`Ошибка обработки сообщения для аккаунта ${accountId}:`, error);
        
        // resolve() ошибки обрабатываются глобально в app.js
        
        // Если ошибка связана с соединением, пытаемся переподключиться
        if (error.message.includes('CONNECTION') || error.message.includes('TIMEOUT')) {
          this.scheduleReconnect(accountId);
        }
      }
    };

    // Добавляем обработчик новых сообщений с более строгой фильтрацией
    try {
      console.log(`Добавляем обработчик событий для аккаунта ${accountId}...`);
      
      // Основной обработчик для UpdateNewMessage
      client.addEventHandler(eventHandler, new Api.UpdateNewMessage({}));
      
      // Простой обработчик для всех сообщений (NewMessage)
      try {
        const { NewMessage } = await import('telegram/events/index.js');
        const simpleHandler = async (event) => {
          console.log(`📨 NewMessage event получен:`, {
            text: event.message?.text?.substring(0, 30),
            chatId: event.chatId?.toString(),
            peerId: event.peerId?.toString()
          });
          
          // Создаем объект как в UpdateNewMessage
          const fakeUpdate = {
            message: event.message,
            chatId: event.chatId,
            peerId: event.peerId
          };
          
          await this.handleNewMessage(fakeUpdate, accountId);
        };
        
        client.addEventHandler(simpleHandler, new NewMessage({}));
        console.log(`✅ NewMessage обработчик добавлен`);
      } catch (newMessageError) {
        console.log(`⚠️ Не удалось добавить NewMessage обработчик:`, newMessageError.message);
      }
      
      // Также добавляем обработчик для всех обновлений (для диагностики)
      const debugHandler = async (update) => {
        // Показываем только интересные обновления, не connection state
        if (update?.constructor?.name !== 'UpdateConnectionState') {
          console.log(`🔔 Получено обновление:`, {
            type: update?.constructor?.name,
            className: update?.className,
            hasMessage: !!update?.message,
            messageText: update?.message?.text?.substring(0, 30)
          });
        }
        
        // Если это сообщение, пробуем обработать его напрямую
        if (update?.message) {
          console.log(`📨 Найдено сообщение в обновлении, пробуем обработать...`);
          await eventHandler(update);
        }
      };
      
      client.addEventHandler(debugHandler);
      
      // Пробуем также без фильтра
      const universalHandler = async (update) => {
        if (update?.message && update?.message?.text) {
          console.log(`🌐 Универсальный обработчик получил сообщение: "${update.message.text.substring(0, 30)}..."`);
          await this.handleNewMessage(update, accountId);
        }
      };
      
      client.addEventHandler(universalHandler);
      
      // Проверяем статус подключения
      const isConnected = client.connected;
      console.log(`Статус подключения клиента ${accountId}: ${isConnected}`);
      
      // Пытаемся получить информацию о себе для проверки
      try {
        const me = await client.getMe();
        console.log(`✅ Клиент ${accountId} активен, пользователь: ${me.firstName} (@${me.username})`);
        
        // Отправляем тестовое сообщение самому себе для проверки обработчика
        setTimeout(async () => {
          try {
            await client.sendMessage('me', { message: '🔧 Тест обработчика событий' });
            console.log(`📤 Отправлено тестовое сообщение для аккаунта ${accountId}`);
            
            // Активируем получение обновлений через catchUp
            console.log(`🔄 Активируем получение обновлений для аккаунта ${accountId}...`);
            try {
              await client.catchUp();
              console.log(`✅ Получение обновлений активировано для аккаунта ${accountId}`);
            } catch (catchUpError) {
              console.log(`⚠️ Ошибка активации обновлений:`, catchUpError.message);
              
              // Пробуем альтернативный способ - запросить диалоги для активации
              try {
                console.log(`🔄 Пробуем активировать через getDialogs...`);
                await client.getDialogs({ limit: 1 });
                console.log(`✅ Обновления активированы через getDialogs`);
                
                // Принудительно запускаем получение обновлений
                console.log(`🔄 Принудительно запускаем получение обновлений...`);
                try {
                  // Подписываемся на обновления принудительно
                  client._updateLoop = true;
                  console.log(`✅ Update loop активирован`);
                } catch (loopError) {
                  console.log(`⚠️ Ошибка активации update loop:`, loopError.message);
                }
                
                // Попробуем получить последние сообщения из мониторимых групп
                const data = this.db.read();
                for (const groupId of data.groups) {
                  try {
                    console.log(`🔍 Проверяем последние сообщения в группе ${groupId}...`);
                    const messages = await client.getMessages(groupId, { limit: 3 });
                    console.log(`📋 Найдено ${messages.length} сообщений в группе ${groupId}`);
                    for (const msg of messages) {
                      if (msg.text) {
                        console.log(`💬 Сообщение: "${msg.text.substring(0, 50)}..." от ${msg.senderId}`);
                        
                        // РУЧНАЯ ПРОВЕРКА: Проверим это сообщение на стоп-слова
                        console.log(`🔍 РУЧНАЯ ПРОВЕРКА сообщения: "${msg.text}"`);
                        const messageText = msg.text.toLowerCase();
                        for (const stopword of data.stopwords) {
                          if (messageText.includes(stopword.toLowerCase())) {
                            console.log(`🚨 НАЙДЕНО СТОП-СЛОВО "${stopword}" в сообщении!`);
                            console.log(`📊 Записываем в статистику...`);
                            await this.statsCollector.recordStopwordHit(groupId, stopword, {
                              id: msg.id,
                              date: msg.date,
                              senderId: msg.senderId
                            });
                          }
                        }
                      }
                    }
                  } catch (messagesError) {
                    console.log(`⚠️ Не удалось получить сообщения из ${groupId}:`, messagesError.message);
                  }
                }
                
              } catch (dialogsError) {
                console.log(`⚠️ Ошибка getDialogs:`, dialogsError.message);
              }
            }
            
          } catch (testError) {
            console.error(`❌ Ошибка отправки тестового сообщения ${accountId}:`, testError);
          }
        }, 2000); // Отправляем через 2 секунды после запуска
        
      } catch (meError) {
        console.error(`❌ Ошибка получения информации о пользователе ${accountId}:`, meError);
      }
      
    } catch (error) {
      console.error(`Ошибка добавления обработчика событий для аккаунта ${accountId}:`, error);
      return;
    }
    this.eventHandlers.set(accountId, eventHandler);
    
    console.log(`✅ Обработчик событий успешно добавлен для аккаунта ${accountId}`);
  }

  async handleNewMessage(event, accountId) {
    const message = event.message;
    if (!message || !message.text) return;

    console.log(`📨 Получено сообщение от аккаунта ${accountId}:`, {
      text: message.text.substring(0, 50) + '...',
      chatId: message.chatId?.toString(),
      peerId: message.peerId?.toString(),
      username: message.chat?.username,
      fullMessage: JSON.stringify(message, null, 2).substring(0, 500) + '...'
    });

    const data = this.db.read();
    const stopwords = data.stopwords;
    const monitoredGroups = data.groups;
    const mode = data.mode;

    console.log(`📋 Конфигурация мониторинга:`, {
      stopwords,
      monitoredGroups,
      mode
    });

    // Получаем ID чата
    const chatId = message.chatId?.toString() || message.peerId?.toString();
    if (!chatId) {
      console.log('❌ Не удалось получить ID чата');
      return;
    }

    console.log(`🔍 ID чата: ${chatId}`);

    // Проверяем, мониторится ли эта группа
    const isMonitored = monitoredGroups.some(group => {
      // Проверяем по ID и по username
      let matches = false;
      
      // Прямое совпадение ID
      if (group === chatId) {
        matches = true;
      }
      // Совпадение по username
      else if (group === `@${message.chat?.username}`) {
        matches = true;
      }
      // Проверяем, если группа добавлена по username, а chatId содержит внутренний ID
      else if (group.startsWith('@') && chatId.includes(group.substring(1))) {
        matches = true;
      }
      // Проверяем полный ID (-100...) против внутреннего ID
      else if (group.startsWith('-100') && chatId === group.substring(4)) {
        matches = true;
      }
      // Обратная проверка: если chatId это полный ID, а group - внутренний
      else if (chatId.startsWith('-100') && group === chatId.substring(4)) {
        matches = true;
      }
      
      console.log(`🔍 Проверка группы "${group}" против "${chatId}" (@${message.chat?.username}): ${matches}`);
      return matches;
    });

    console.log(`📍 Группа мониторится: ${isMonitored}`);

    if (!isMonitored) {
      console.log('❌ Группа не мониторится, пропускаем сообщение');
      return;
    }

    const messageText = message.text.toLowerCase();
    console.log(`🔍 Текст сообщения для проверки: "${messageText}"`);
    
    // Проверяем на наличие стоп-слов
    for (const stopword of stopwords) {
      console.log(`🔍 Проверяем стоп-слово: "${stopword}"`);
      if (messageText.includes(stopword.toLowerCase())) {
        console.log(`🚨 Найдено стоп-слово "${stopword}" в ${chatId}`);
        
        // Записываем статистику
        await this.statsCollector.recordStopwordHit(chatId, stopword, {
          id: message.id,
          date: message.date,
          fromId: message.fromId?.toString()
        });

        // Отправляем уведомление администраторам через бота
        const shortText = message.text.substring(0, 100) + (message.text.length > 100 ? '...' : '');
        this.notifyAdmins(`🚨 Найдено стоп-слово: "${stopword}"\n📍 Группа: ${chatId}\n💬 Текст: ${shortText}`);

        // Отправляем жалобу или логируем в зависимости от режима
        if (mode === 'run') {
          this.queueReport(accountId, message, chatId, stopword);
        } else {
          console.log(`📝 ТЕСТ-РЕЖИМ: Жалоба не отправлена (${stopword} в ${chatId})`);
          this.notifyAdmins(`📝 ТЕСТ-РЕЖИМ: Жалоба не отправлена на "${stopword}" в ${chatId}`);
        }

        // Прерываем цикл после первого найденного стоп-слова
        break;
      }
    }
    
    console.log('✅ Проверка стоп-слов завершена, совпадений не найдено');
  }

  async reportMessage(accountId, message, chatId) {
    const client = this.accountManager.getClient(accountId);
    if (!client) {
      console.error(`Клиент для аккаунта ${accountId} не найден`);
      return;
    }

    try {
      await client.invoke(new Api.messages.ReportRequest({
        peer: chatId,
        id: [message.id],
        reason: new Api.InputReportReasonSpam(),
        message: 'Автоматическая жалоба на спам'
      }));

      console.log(`✅ Жалоба отправлена на сообщение ${message.id} в ${chatId}`);
      
      this.notifyAdmins(`✅ Жалоба отправлена на сообщение ${message.id} в ${chatId}`);

    } catch (error) {
      console.error(`Ошибка отправки жалобы на сообщение ${message.id}:`, error);
      
      this.notifyAdmins(`❌ Ошибка отправки жалобы на сообщение ${message.id} в ${chatId}: ${error.message}`);
    }
  }

  scheduleReconnect(accountId) {
    const maxAttempts = 5;
    const baseDelay = 1000; // 1 секунда
    
    const attempts = this.reconnectAttempts.get(accountId) || 0;
    
    if (attempts >= maxAttempts) {
      console.error(`Превышено максимальное количество попыток переподключения для аккаунта ${accountId}`);
      return;
    }

    // Экспоненциальная задержка: 1, 2, 4, 8, 16 секунд
    const delay = baseDelay * Math.pow(2, attempts);
    
    console.log(`Попытка переподключения ${attempts + 1}/${maxAttempts} для аккаунта ${accountId} через ${delay}ms`);
    
    const timeoutId = setTimeout(async () => {
      try {
        const account = this.db.read().accounts.find(acc => acc.id === accountId);
        if (!account) return;

        // Создаем новый клиент для переподключения
        const session = this.accountManager.loadSession(accountId);
        const client = new TelegramClient(session, 
          this.accountManager.apiId, 
          this.accountManager.apiHash, {
            connectionRetries: 5,
            useWSS: false,
          });

        await client.connect();
        
        if (await client.checkAuthorization()) {
          // Обновляем клиент в менеджере
          this.accountManager.clients.set(accountId, client);
          
          // Переподключение успешно
          console.log(`✅ Аккаунт ${accountId} успешно переподключен`);
          this.reconnectAttempts.delete(accountId);
          this.reconnectTimeouts.delete(accountId);
          
          // Добавляем обработчик событий заново
          if (this.isActive) {
            await this.addEventHandler(accountId);
          }
          
          this.notifyAdmins(`🔄 Аккаунт ${accountId} переподключен`);
        } else {
          throw new Error('Требуется повторная авторизация');
        }
      } catch (error) {
        console.error(`Ошибка переподключения аккаунта ${accountId}:`, error);
        this.reconnectAttempts.set(accountId, attempts + 1);
        this.scheduleReconnect(accountId);
      }
    }, delay);
    
    this.reconnectAttempts.set(accountId, attempts + 1);
    this.reconnectTimeouts.set(accountId, timeoutId);
  }

  isRunning() {
    return this.isActive;
  }

  getStatus() {
    const connectedAccounts = this.accountManager.getConnectedAccounts();
    return {
      isActive: this.isActive,
      connectedAccounts: connectedAccounts.length,
      totalAccounts: this.db.read().accounts.length,
      monitoredGroups: this.db.read().groups.length,
      stopwordsCount: this.db.read().stopwords.length,
      mode: this.db.read().mode
    };
  }

  // Методы для работы с уведомлениями
  addAdmin(userId) {
    this.adminUsers.add(userId.toString());
  }

  removeAdmin(userId) {
    this.adminUsers.delete(userId.toString());
  }

  async notifyAdmins(message) {
    if (!this.bot || this.adminUsers.size === 0) {
      return;
    }

    for (const userId of this.adminUsers) {
      try {
        await this.bot.telegram.sendMessage(userId, message);
      } catch (error) {
        console.error(`Ошибка отправки уведомления администратору ${userId}:`, error);
      }
    }
  }

  // Методы для защиты от блокировки
  startQueueProcessor() {
    if (this.queueProcessor) {
      clearInterval(this.queueProcessor);
    }
    
    this.queueProcessor = setInterval(() => {
      this.processReportQueue();
    }, 30000); // Проверяем очередь каждые 30 секунд
  }

  queueReport(accountId, message, chatId, stopword) {
    const reportData = {
      accountId,
      message,
      chatId,
      stopword,
      timestamp: Date.now(),
      id: `${accountId}_${message.id}_${Date.now()}`
    };

    // Проверяем лимиты перед добавлением в очередь
    if (this.canSendReport(accountId)) {
      this.reportQueue.push(reportData);
      console.log(`📋 Жалоба добавлена в очередь: ${stopword} в ${chatId} (позиция ${this.reportQueue.length})`);
      this.notifyAdmins(`📋 Жалоба добавлена в очередь: "${stopword}" в ${chatId}`);
    } else {
      console.log(`⚠️ Лимит жалоб превышен для аккаунта ${accountId}. Жалоба пропущена.`);
      this.notifyAdmins(`⚠️ Лимит жалоб превышен для аккаунта ${accountId}. Жалоба на "${stopword}" пропущена.`);
    }
  }

  canSendReport(accountId) {
    const now = Date.now();
    const history = this.reportHistory.get(accountId) || [];
    
    // Очищаем старые записи (старше 24 часов)
    const dayAgo = now - (24 * 60 * 60 * 1000);
    const hourAgo = now - (60 * 60 * 1000);
    
    const recentReports = history.filter(timestamp => timestamp > dayAgo);
    const hourlyReports = recentReports.filter(timestamp => timestamp > hourAgo);
    
    // Обновляем историю
    this.reportHistory.set(accountId, recentReports);
    
    // Проверяем лимиты
    const dailyLimit = recentReports.length < this.maxReportsPerDay;
    const hourlyLimit = hourlyReports.length < this.maxReportsPerHour;
    
    return dailyLimit && hourlyLimit;
  }

  async processReportQueue() {
    if (this.isProcessingQueue || this.reportQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      const report = this.reportQueue.shift();
      
      if (!report) {
        this.isProcessingQueue = false;
        return;
      }

      // Проверяем, не устарела ли жалоба (не старше 1 часа)
      const reportAge = Date.now() - report.timestamp;
      const maxAge = 60 * 60 * 1000; // 1 час
      
      if (reportAge > maxAge) {
        console.log(`⏰ Жалоба устарела и пропущена: ${report.stopword} в ${report.chatId}`);
        this.isProcessingQueue = false;
        return;
      }

      // Повторно проверяем лимиты
      if (!this.canSendReport(report.accountId)) {
        console.log(`⚠️ Лимит жалоб превышен при обработке для аккаунта ${report.accountId}`);
        this.isProcessingQueue = false;
        return;
      }

      // Отправляем жалобу
      await this.sendReportWithDelay(report);
      
    } catch (error) {
      console.error('Ошибка обработки очереди жалоб:', error);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async sendReportWithDelay(report) {
    // Случайная задержка между минимальной и максимальной
    const delay = Math.random() * (this.reportDelayMax - this.reportDelayMin) + this.reportDelayMin;
    
    console.log(`⏱️ Ожидание ${Math.round(delay / 1000)} секунд перед отправкой жалобы...`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Отправляем жалобу
    await this.reportMessage(report.accountId, report.message, report.chatId);
    
    // Записываем в историю
    const history = this.reportHistory.get(report.accountId) || [];
    history.push(Date.now());
    this.reportHistory.set(report.accountId, history);
    
    console.log(`✅ Жалоба отправлена с задержкой: ${report.stopword} в ${report.chatId}`);
  }

  getQueueStatus() {
    const queueLength = this.reportQueue.length;
    const accountStats = {};
    
    for (const [accountId, history] of this.reportHistory) {
      const now = Date.now();
      const hourAgo = now - (60 * 60 * 1000);
      const dayAgo = now - (24 * 60 * 60 * 1000);
      
      const recentReports = history.filter(timestamp => timestamp > dayAgo);
      const hourlyReports = recentReports.filter(timestamp => timestamp > hourAgo);
      
      accountStats[accountId] = {
        reportsToday: recentReports.length,
        reportsThisHour: hourlyReports.length,
        canSendMore: this.canSendReport(accountId)
      };
    }
    
    return {
      queueLength,
      accountStats,
      isProcessing: this.isProcessingQueue
    };
  }

  // Периодический мониторинг
  startPeriodicMonitoring() {
    console.log(`🔄 Запускаем периодический мониторинг (каждые ${this.monitorInterval/1000} секунд)`);
    
    // Первая проверка через 10 секунд после запуска
    setTimeout(() => {
      this.checkForNewMessages();
    }, 10000);
    
    // Затем каждые 45 секунд
    this.periodicMonitor = setInterval(() => {
      this.checkForNewMessages();
    }, this.monitorInterval);
  }

  async checkForNewMessages() {
    if (!this.isActive) return;
    
    console.log(`🔍 Периодическая проверка новых сообщений...`);
    
    const data = this.db.read();
    const stopwords = data.stopwords;
    const monitoredGroups = data.groups;
    const mode = data.mode;
    
    if (stopwords.length === 0 || monitoredGroups.length === 0) {
      console.log(`⚠️ Нет стоп-слов или групп для мониторинга`);
      return;
    }
    
    const accounts = this.accountManager.getConnectedAccounts();
    if (accounts.length === 0) {
      console.log(`⚠️ Нет подключенных аккаунтов`);
      return;
    }
    
    // Используем первый доступный аккаунт
    const client = this.accountManager.getClient(accounts[0].id);
    if (!client) {
      console.log(`⚠️ Клиент недоступен`);
      return;
    }
    
    let totalNewMessages = 0;
    let totalStopwords = 0;
    
    for (const groupId of monitoredGroups) {
      try {
        // Получаем последний проверенный ID для этой группы
        const lastMessageId = this.lastMessageIds.get(groupId) || 0;
        
        // Получаем новые сообщения (больше чем lastMessageId)
        const messages = await client.getMessages(groupId, { 
          limit: 20, // Проверяем последние 20 сообщений
          minId: lastMessageId // Только сообщения новее чем lastMessageId
        });
        
        if (messages.length > 0) {
          console.log(`📋 Найдено ${messages.length} новых сообщений в группе ${groupId}`);
          totalNewMessages += messages.length;
          
          // Обновляем последний ID
          const newestMessageId = Math.max(...messages.map(m => m.id));
          this.lastMessageIds.set(groupId, newestMessageId);
          
          // Проверяем каждое новое сообщение на стоп-слова
          for (const msg of messages.reverse()) { // reverse для обработки от старых к новым
            if (msg.text) {
              const messageText = msg.text.toLowerCase();
              
              for (const stopword of stopwords) {
                if (messageText.includes(stopword.toLowerCase())) {
                  console.log(`🚨 НАЙДЕНО СТОП-СЛОВО "${stopword}" в новом сообщении!`);
                  console.log(`💬 Сообщение: "${msg.text.substring(0, 100)}..."`);
                  console.log(`📊 Записываем в статистику...`);
                  
                  totalStopwords++;
                  
                  // Записываем статистику
                  await this.statsCollector.recordStopwordHit(groupId, stopword, {
                    id: msg.id,
                    date: msg.date,
                    senderId: msg.senderId
                  });
                  
                  // Отправляем уведомление администраторам
                  const shortText = msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : '');
                  this.notifyAdmins(`🚨 Найдено стоп-слово: "${stopword}"\n📍 Группа: ${groupId}\n💬 Текст: ${shortText}`);
                  
                  // Отправляем жалобу или логируем в зависимости от режима
                  if (mode === 'run') {
                    this.queueReport(accounts[0].id, msg, groupId, stopword);
                  } else {
                    console.log(`📝 ТЕСТ-РЕЖИМ: Жалоба не отправлена (${stopword} в ${groupId})`);
                    this.notifyAdmins(`📝 ТЕСТ-РЕЖИМ: Жалоба не отправлена на "${stopword}" в ${groupId}`);
                  }
                  
                  // Прерываем цикл после первого найденного стоп-слова в сообщении
                  break;
                }
              }
            }
          }
        } else {
          console.log(`✅ Нет новых сообщений в группе ${groupId}`);
        }
        
      } catch (error) {
        console.error(`❌ Ошибка проверки группы ${groupId}:`, error.message);
      }
    }
    
    if (totalNewMessages > 0) {
      console.log(`📊 Итого: проверено ${totalNewMessages} новых сообщений, найдено ${totalStopwords} стоп-слов`);
      if (totalStopwords > 0) {
        this.notifyAdmins(`📊 Периодическая проверка: ${totalNewMessages} новых сообщений, ${totalStopwords} стоп-слов найдено`);
      }
    } else {
      console.log(`✅ Новых сообщений не найдено`);
    }
  }
}