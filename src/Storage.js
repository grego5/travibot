import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Storage {
  constructor(storageFile, entries) {
    this.storageFile = path.join(__dirname, "temp", storageFile);
    this.storage = {};

    try {
      const data = readFileSync(this.storageFile, "utf8");
      this.storage = JSON.parse(data);
      entries.forEach(([key, value]) => {
        if (!this.storage[key]) storage[key] = value;
      });
    } catch (error) {
      if (error.code === "ENOENT") {
        writeFileSync(this.storageFile, "{}", "utf8");
      } else {
        console.error("Error loading localStorage data:", error);
        throw error;
      }
    }
  }

  save() {
    writeFileSync(this.storageFile, JSON.stringify(this.storage, null, 2), "utf8");
  }

  get(key) {
    return this.storage[key] || null;
  }

  set(key, value) {
    this.storage[key] = value;
    this.save();
  }
  delete(key) {
    delete this.storage[key];
    this.save();
  }
  clear() {
    this.storage = {};
    this.save();
  }
  getAll() {
    return { ...this.storage };
  }
}

export default Storage;
