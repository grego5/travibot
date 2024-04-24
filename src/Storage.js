import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const { readFileSync } = fs;
const { writeFile } = fs.promises;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class FileWriter {
  constructor() {
    this.queueMap = new Map();
    this.busy = new Set();
  }

  write = async (path, data) => {
    this.queueMap.set(path, data);
    await this.processQueue(path);
  };

  processQueue = async (path) => {
    if (this.busy.has(path)) return;

    this.busy.add(path);
    const data = this.queueMap.get(path);
    this.queueMap.delete(path);

    try {
      await writeFile(path, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error("Error writing to file:", error);
    } finally {
      this.busy.delete(path);
      if (this.queueMap.has(path)) await this.processQueue(path);
    }
  };
}

const { write } = new FileWriter();

class Storage {
  constructor(storeName, entries) {
    this.storagePath = path.join(__dirname, storeName);
    this.pathMap = {};
    this.storage = {};
    this.keys = [];

    entries.forEach(({ key, value, volatile }) => {
      this.keys.push(key);
      this.storage[key] = value;
      const filePath = path.join(this.storagePath, key + ".json");
      this.pathMap[key] = filePath;
      if (volatile) return;

      try {
        const text = readFileSync(filePath);
        const data = JSON.parse(text);
        this.storage[key] = data;
      } catch (error) {
        if (error.code === "ENOENT") {
          write(filePath, value);
        } else {
          console.error(error);
          throw error;
        }
      }
    });
  }

  save(list = []) {
    if (!list.length) {
      for (const k in this.pathMap) {
        write(this.pathMap[k], this.storage[k]);
      }
    } else {
      for (const k of list) {
        if (k in this.pathMap) write(this.pathMap[k], this.storage[k]);
        else console.log(`Storage: File path for the key ${k} does not exist`);
      }
    }
  }

  get(key) {
    return this.storage[key] || null;
  }

  set(key, value) {
    this.storage[key] = value;
    if (key in this.pathMap) write(this.pathMap[key], value);
  }

  getAll() {
    return this.storage;
  }
}

export default Storage;
