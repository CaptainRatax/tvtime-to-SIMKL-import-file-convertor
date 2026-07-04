'use strict';

const { MongoClient } = require('mongodb');

const DEFAULT_DB_NAME = 'tvtime_simkl';
const DEFAULT_COLLECTION = 'simkl_id_mappings';
const DEFAULT_SESSION_COLLECTION = 'simkl_sessions';

class MongoMappingStore {
  constructor(options) {
    const config = options || {};
    this.url = String(config.url || '').trim();
    this.dbName = config.dbName || dbNameFromUrl(this.url) || DEFAULT_DB_NAME;
    this.collectionName = config.collectionName || DEFAULT_COLLECTION;
    this.sessionCollectionName = config.sessionCollectionName || DEFAULT_SESSION_COLLECTION;
    this.client = null;
    this.collection = null;
    this.sessionCollection = null;
    this.ready = null;

    if (!this.url) {
      throw new Error('Missing MONGODB_URL.');
    }
  }

  async connect() {
    if (this.ready) {
      return this.ready;
    }

    this.ready = (async () => {
      this.client = new MongoClient(this.url);
      await this.client.connect();
      const db = this.client.db(this.dbName);
      this.collection = db.collection(this.collectionName);
      this.sessionCollection = db.collection(this.sessionCollectionName);
      await this.collection.createIndex({ sourceType: 1, normalizedTitle: 1, year: 1 }, { unique: true });
      await this.collection.createIndex({ 'simkl.id': 1 });
      await this.sessionCollection.createIndex({ updatedAt: 1 });
      return this.collection;
    })();

    return this.ready;
  }

  async getMappings(records) {
    const collection = await this.connect();
    const ids = [...new Set((records || []).map((record) => record.id).filter(Boolean))];
    if (!ids.length) {
      return new Map();
    }

    const rows = await collection.find({ _id: { $in: ids } }).toArray();
    return new Map(rows.map((row) => [row._id, row]));
  }

  async saveMappings(mappings) {
    const collection = await this.connect();
    const rows = (mappings || []).filter((mapping) => mapping && mapping._id && mapping.simkl && mapping.simkl.id);
    if (!rows.length) {
      return { matched: 0, modified: 0, upserted: 0, saved: 0 };
    }

    const now = new Date();
    const result = await collection.bulkWrite(rows.map((mapping) => ({
      updateOne: {
        filter: { _id: mapping._id },
        update: {
          $set: {
            ...mapping,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        upsert: true,
      },
    })), { ordered: false });

    return {
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upserted: result.upsertedCount,
      saved: rows.length,
    };
  }

  async saveSession(session) {
    await this.connect();
    if (!session || !session.id) {
      return { saved: 0 };
    }

    const now = new Date();
    const snapshot = sanitizeSession(session);
    await this.sessionCollection.updateOne({
      _id: snapshot.id,
    }, {
      $set: {
        ...snapshot,
        updatedAt: now,
      },
      $setOnInsert: {
        persistedAt: now,
      },
    }, {
      upsert: true,
    });

    return { saved: 1 };
  }

  async getSession(sessionId) {
    await this.connect();
    const id = String(sessionId || '').trim();
    if (!id) {
      return null;
    }

    const row = await this.sessionCollection.findOne({ _id: id });
    if (!row) {
      return null;
    }

    const session = {
      ...row,
      id: row.id || row._id,
    };
    delete session._id;
    delete session.updatedAt;
    delete session.persistedAt;
    return session;
  }
}

function createMongoStoreFromEnv() {
  const url = String(process.env.MONGODB_URL || '').trim();
  if (!url) {
    return null;
  }

  return new MongoMappingStore({
    url,
    dbName: process.env.MONGODB_DB || dbNameFromUrl(url) || DEFAULT_DB_NAME,
    collectionName: process.env.MONGODB_COLLECTION || DEFAULT_COLLECTION,
    sessionCollectionName: process.env.MONGODB_SESSION_COLLECTION || DEFAULT_SESSION_COLLECTION,
  });
}

function sanitizeSession(session) {
  return JSON.parse(JSON.stringify({
    ...session,
    clientId: '',
  }));
}

function dbNameFromUrl(value) {
  try {
    const parsed = new URL(value);
    const name = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    return name || '';
  } catch {
    return '';
  }
}

module.exports = {
  MongoMappingStore,
  createMongoStoreFromEnv,
};
