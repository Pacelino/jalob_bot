export class StatsCollector {
  constructor(db) {
    this.db = db;
  }

  async recordStopwordHit(groupId, word, messageData = {}) {
    try {
      // Увеличиваем счетчик в базе данных
      await this.db.incrementStat(groupId, word);
      
      // Логируем событие
      console.log(`📊 Стоп-слово "${word}" найдено в ${groupId}`, {
        messageId: messageData.id,
        date: messageData.date,
        fromId: messageData.fromId
      });
      
      return true;
    } catch (error) {
      console.error('Ошибка записи статистики:', error);
      return false;
    }
  }

  getStats() {
    const data = this.db.read();
    return data.stats;
  }

  getFormattedStats() {
    const stats = this.getStats();
    const formatted = [];
    
    for (const [groupId, words] of Object.entries(stats)) {
      for (const [word, count] of Object.entries(words)) {
        formatted.push({
          group: groupId,
          word: word,
          count: count
        });
      }
    }
    
    // Сортируем по количеству срабатываний (по убыванию)
    formatted.sort((a, b) => b.count - a.count);
    
    return formatted;
  }

  getTotalStats() {
    const stats = this.getStats();
    let totalWords = 0;
    let totalHits = 0;
    const uniqueWords = new Set();
    
    for (const [groupId, words] of Object.entries(stats)) {
      for (const [word, count] of Object.entries(words)) {
        uniqueWords.add(word);
        totalHits += count;
      }
    }
    
    totalWords = uniqueWords.size;
    
    return {
      totalGroups: Object.keys(stats).length,
      totalWords,
      totalHits,
      uniqueWords: Array.from(uniqueWords)
    };
  }

  getGroupStats(groupId) {
    const stats = this.getStats();
    return stats[groupId] || {};
  }

  getWordStats(word) {
    const stats = this.getStats();
    const wordStats = {};
    
    for (const [groupId, words] of Object.entries(stats)) {
      if (words[word]) {
        wordStats[groupId] = words[word];
      }
    }
    
    return wordStats;
  }

  async clearStats() {
    try {
      await this.db.clearStats();
      console.log('📊 Статистика очищена');
      return true;
    } catch (error) {
      console.error('Ошибка очистки статистики:', error);
      return false;
    }
  }

  // Получить топ стоп-слов
  getTopWords(limit = 10) {
    const formatted = this.getFormattedStats();
    const wordTotals = {};
    
    // Суммируем по словам
    for (const stat of formatted) {
      if (!wordTotals[stat.word]) {
        wordTotals[stat.word] = 0;
      }
      wordTotals[stat.word] += stat.count;
    }
    
    // Преобразуем в массив и сортируем
    const topWords = Object.entries(wordTotals)
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    
    return topWords;
  }

  // Получить топ групп по активности
  getTopGroups(limit = 10) {
    const stats = this.getStats();
    const groupTotals = {};
    
    for (const [groupId, words] of Object.entries(stats)) {
      groupTotals[groupId] = Object.values(words).reduce((sum, count) => sum + count, 0);
    }
    
    const topGroups = Object.entries(groupTotals)
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    
    return topGroups;
  }

  // Экспорт статистики в JSON
  exportStats() {
    const stats = this.getStats();
    const totalStats = this.getTotalStats();
    const topWords = this.getTopWords();
    const topGroups = this.getTopGroups();
    
    return {
      exportDate: new Date().toISOString(),
      totalStats,
      topWords,
      topGroups,
      detailedStats: stats
    };
  }
}