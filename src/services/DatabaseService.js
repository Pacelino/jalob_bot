import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class DatabaseService {
  constructor() {
    // Определяем директорию данных. На Railway используйте Volume, смонтированный в /data.
    const projectRoot = join(dirname(dirname(__dirname)));
    const dataDir = process.env.DATA_DIR || projectRoot;
    
    // Создаем директорию данных при необходимости
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    
    const dbPath = join(dataDir, 'db.json');
    
    // Создаем папку sessions если её нет
    const sessionsDir = join(dataDir, 'sessions');
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
    
    this.adapter = new JSONFile(dbPath);
    this.db = new Low(this.adapter, this.getDefaultData());
    
    this.init();
  }

  getDefaultData() {
    return {
      accounts: [],
      groups: [],
      stopwords: [],
      mode: process.env.DEFAULT_MODE || 'test',
      stats: {}
    };
  }

  async init() {
    await this.db.read();
    
    // Если файл пустой или отсутствует, создаем дефолтную структуру
    if (!this.db.data) {
      this.db.data = this.getDefaultData();
      await this.db.write();
    }
    
    // Проверяем и дополняем структуру данных если что-то отсутствует
    const defaultData = this.getDefaultData();
    let needsUpdate = false;
    
    for (const key of Object.keys(defaultData)) {
      if (!(key in this.db.data)) {
        this.db.data[key] = defaultData[key];
        needsUpdate = true;
      }
    }
    
    if (needsUpdate) {
      await this.db.write();
    }
  }

  read() {
    return this.db.data;
  }

  async write() {
    await this.db.write();
  }

  // Методы для работы с аккаунтами
  async addAccount(accountData) {
    await this.db.read();
    this.db.data.accounts.push(accountData);
    await this.db.write();
  }

  async removeAccount(accountId) {
    await this.db.read();
    this.db.data.accounts = this.db.data.accounts.filter(acc => acc.id !== accountId);
    await this.db.write();
  }

  async updateAccount(accountId, updates) {
    await this.db.read();
    const accountIndex = this.db.data.accounts.findIndex(acc => acc.id === accountId);
    if (accountIndex !== -1) {
      this.db.data.accounts[accountIndex] = { ...this.db.data.accounts[accountIndex], ...updates };
      await this.db.write();
    }
  }

  // Методы для работы с группами
  async addGroup(groupId) {
    await this.db.read();
    if (!this.db.data.groups.includes(groupId)) {
      this.db.data.groups.push(groupId);
      await this.db.write();
    }
  }

  async removeGroup(groupId) {
    await this.db.read();
    this.db.data.groups = this.db.data.groups.filter(g => g !== groupId);
    // Также удаляем статистику для этой группы
    delete this.db.data.stats[groupId];
    await this.db.write();
  }

  // Методы для работы со стоп-словами
  async addStopwords(words) {
    await this.db.read();
    const newWords = words.filter(word => !this.db.data.stopwords.includes(word));
    this.db.data.stopwords.push(...newWords);
    await this.db.write();
  }

  async removeStopwords(words) {
    await this.db.read();
    this.db.data.stopwords = this.db.data.stopwords.filter(word => !words.includes(word));
    await this.db.write();
  }

  // Методы для работы с режимом
  async setMode(mode) {
    await this.db.read();
    this.db.data.mode = mode;
    await this.db.write();
  }

  // Методы для работы со статистикой
  async incrementStat(groupId, word) {
    await this.db.read();
    if (!this.db.data.stats[groupId]) {
      this.db.data.stats[groupId] = {};
    }
    if (!this.db.data.stats[groupId][word]) {
      this.db.data.stats[groupId][word] = 0;
    }
    this.db.data.stats[groupId][word]++;
    await this.db.write();
  }

  async clearStats() {
    await this.db.read();
    this.db.data.stats = {};
    await this.db.write();
  }
}