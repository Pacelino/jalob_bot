import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class AccountManager {
  constructor(db) {
    this.db = db;
    this.clients = new Map(); // accountId -> TelegramClient
    this.sessions = new Map(); // accountId -> StringSession
    this.apiId = parseInt(process.env.API_ID);
    this.apiHash = process.env.API_HASH;
    
    if (!this.apiId || !this.apiHash) {
      throw new Error('API_ID и API_HASH должны быть настроены в config.env');
    }
  }

  generateAccountId(phone) {
    return crypto.createHash('md5').update(phone).digest('hex');
  }

  getSessionPath(accountId) {
    const projectRoot = join(dirname(dirname(__dirname)));
    const dataDir = process.env.DATA_DIR || projectRoot;
    return join(dataDir, 'sessions', `${accountId}.session`);
  }

  loadSession(accountId) {
    const sessionPath = this.getSessionPath(accountId);
    if (existsSync(sessionPath)) {
      try {
        const sessionData = readFileSync(sessionPath, 'utf8');
        return new StringSession(sessionData);
      } catch (error) {
        console.error(`Ошибка загрузки сессии ${accountId}:`, error);
        return new StringSession('');
      }
    }
    return new StringSession('');
  }

  saveSession(accountId, session) {
    const sessionPath = this.getSessionPath(accountId);
    try {
      writeFileSync(sessionPath, session.save());
      console.log(`Сессия ${accountId} сохранена`);
    } catch (error) {
      console.error(`Ошибка сохранения сессии ${accountId}:`, error);
    }
  }

  async createClient(phone) {
    const accountId = this.generateAccountId(phone);
    const session = this.loadSession(accountId);
    
    const client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 5,
      useWSS: false,
      timeout: 60000, // Увеличиваем таймаут до 60 секунд
      retryDelay: 2000, // Увеличиваем задержку до 2 секунд
      maxConcurrentDownloads: 1, // Ограничиваем конкурентные соединения
      receiveUpdates: true, // КРИТИЧНО: включаем получение обновлений в реальном времени
      floodSleepThreshold: 60, // Ждем 60 секунд при flood ошибках
      requestRetries: 5 // Повторные попытки запросов
    });

    try {
      // Подключаемся к Telegram перед использованием
      await client.connect();
      console.log(`Клиент для ${phone} подключен к Telegram`);

      // Проверяем соединение
      if (!client.connected) {
        throw new Error('Не удалось установить соединение с Telegram');
      }

      this.clients.set(accountId, client);
      this.sessions.set(accountId, session);
      
      return { client, accountId };
    } catch (error) {
      console.error(`Ошибка подключения клиента для ${phone}:`, error);
      // Пытаемся отключить клиент в случае ошибки
      try {
        await client.disconnect();
      } catch (disconnectError) {
        console.error('Ошибка отключения клиента:', disconnectError);
      }
      throw error;
    }
  }

  async loginAccount(phone, codeCallback, passwordCallback) {
    try {
      const { client, accountId } = await this.createClient(phone);
      
      console.log(`Начинаем авторизацию для ${phone}`);
      
      const result = await client.start({
        phoneNumber: async () => phone,
        phoneCode: codeCallback,
        password: passwordCallback,
        onError: (err) => {
          console.error('Ошибка авторизации:', err);
          throw err;
        },
      });

      if (result) {
        // Сохраняем сессию
        this.saveSession(accountId, client.session);
        
        // Получаем информацию о пользователе
        const me = await client.getMe();
        
        // Сохраняем в базу данных
        const accountData = {
          id: accountId,
          phone: phone,
          sessionFile: this.getSessionPath(accountId),
          userId: me.id?.toString(),
          username: me.username,
          firstName: me.firstName,
          lastName: me.lastName,
          addedAt: new Date().toISOString()
        };

        await this.db.addAccount(accountData);
        
        console.log(`Аккаунт ${phone} успешно добавлен`);
        return { success: true, accountId, account: accountData };
      }
    } catch (error) {
      console.error(`Ошибка при авторизации ${phone}:`, error);
      return { success: false, error: error.message };
    }
  }

  async removeAccount(accountId) {
    try {
      // Отключаем клиент
      const client = this.clients.get(accountId);
      if (client) {
        await client.disconnect();
        this.clients.delete(accountId);
      }
      
      this.sessions.delete(accountId);
      
      // Удаляем из базы данных
      await this.db.removeAccount(accountId);
      
      console.log(`Аккаунт ${accountId} удален`);
      return { success: true };
    } catch (error) {
      console.error(`Ошибка при удалении аккаунта ${accountId}:`, error);
      return { success: false, error: error.message };
    }
  }

  async connectAllAccounts() {
    const data = this.db.read();
    const results = [];
    
    for (const account of data.accounts) {
      try {
        const session = this.loadSession(account.id);
        const client = new TelegramClient(session, this.apiId, this.apiHash, {
          connectionRetries: 5,
          useWSS: false,
          timeout: 60000,
          retryDelay: 2000,
          maxConcurrentDownloads: 1,
          receiveUpdates: true, // КРИТИЧНО: включаем получение обновлений в реальном времени
          floodSleepThreshold: 60,
          requestRetries: 5
        });

        await client.connect();
        console.log(`Подключение к аккаунту ${account.phone}...`);
        
        if (await client.checkAuthorization()) {
          this.clients.set(account.id, client);
          this.sessions.set(account.id, session);
          console.log(`Аккаунт ${account.phone} подключен`);
          results.push({ accountId: account.id, status: 'connected' });
        } else {
          console.log(`Аккаунт ${account.phone} требует повторной авторизации`);
          results.push({ accountId: account.id, status: 'auth_required' });
        }
      } catch (error) {
        console.error(`Ошибка подключения аккаунта ${account.phone}:`, error);
        results.push({ accountId: account.id, status: 'error', error: error.message });
      }
    }
    
    return results;
  }

  async disconnectAllAccounts() {
    for (const [accountId, client] of this.clients) {
      try {
        await client.disconnect();
        console.log(`Аккаунт ${accountId} отключен`);
      } catch (error) {
        console.error(`Ошибка отключения аккаунта ${accountId}:`, error);
      }
    }
    
    this.clients.clear();
    this.sessions.clear();
  }

  getClient(accountId) {
    return this.clients.get(accountId);
  }

  getAllClients() {
    return Array.from(this.clients.values());
  }

  getConnectedAccounts() {
    const data = this.db.read();
    return data.accounts.filter(account => this.clients.has(account.id));
  }

  // Безопасно прервать и очистить клиент, если авторизация не была завершена
  async abortPendingClient(accountId) {
    try {
      const client = this.clients.get(accountId);
      if (client) {
        try {
          await client.disconnect();
        } catch (e) {
          console.error(`Ошибка при остановке клиента ${accountId}:`, e);
        }
      }
    } finally {
      this.clients.delete(accountId);
      this.sessions.delete(accountId);
    }
  }
}