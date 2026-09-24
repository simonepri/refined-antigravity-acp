#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function findJsonFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.endsWith(".json")) {
      results.push(fullPath);
    }
  }
  return results;
}

class JsonScanner {
  constructor(jsonString, filename) {
    this.src = jsonString;
    this.file = filename;
    this.pos = 0;
  }

  skipWhitespace() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos++;
    }
  }

  parseString() {
    this.pos++; // skip open quote
    let str = "";
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos++];
      if (ch === '"') return str;
      if (ch === "\\") {
        str += this.src[this.pos++];
      } else {
        str += ch;
      }
    }
    throw new Error(`Unterminated string in ${this.file}`);
  }

  parseNumber() {
    const start = this.pos;
    if (this.src[this.pos] === "-") this.pos++;
    while (this.pos < this.src.length && /[0-9.eE+-]/.test(this.src[this.pos])) {
      this.pos++;
    }
    return Number(this.src.slice(start, this.pos));
  }

  parseArray() {
    this.pos++; // skip [
    this.skipWhitespace();
    if (this.src[this.pos] === "]") {
      this.pos++;
      return;
    }
    while (this.pos < this.src.length) {
      this.parseValue();
      this.skipWhitespace();
      if (this.src[this.pos] === "]") {
        this.pos++;
        return;
      }
      if (this.src[this.pos] === ",") {
        this.pos++;
        continue;
      }
      throw new Error(`Expected ',' or ']' at offset ${this.pos} in ${this.file}`);
    }
  }

  parseObject() {
    this.pos++; // skip {
    const keys = new Set();
    this.skipWhitespace();
    if (this.src[this.pos] === "}") {
      this.pos++;
      return;
    }
    while (this.pos < this.src.length) {
      this.skipWhitespace();
      if (this.src[this.pos] !== '"') {
        throw new Error(`Expected string property key at offset ${this.pos} in ${this.file}`);
      }
      const key = this.parseString();
      if (keys.has(key)) {
        throw new Error(`Duplicate object key '${key}' detected in ${this.file}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.src[this.pos] !== ":") {
        throw new Error(`Expected ':' after key at offset ${this.pos} in ${this.file}`);
      }
      this.pos++;
      this.parseValue();
      this.skipWhitespace();
      if (this.src[this.pos] === "}") {
        this.pos++;
        return;
      }
      if (this.src[this.pos] === ",") {
        this.pos++;
        continue;
      }
      throw new Error(`Expected ',' or '}' at offset ${this.pos} in ${this.file}`);
    }
  }

  parseLiteral() {
    if (this.src.startsWith("true", this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.src.startsWith("false", this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.src.startsWith("null", this.pos)) {
      this.pos += 4;
      return null;
    }
    throw new Error(
      `Unexpected character '${this.src[this.pos]}' at offset ${this.pos} in ${this.file}`,
    );
  }

  parseValue() {
    this.skipWhitespace();
    if (this.pos >= this.src.length) throw new Error("Unexpected end of JSON");
    const ch = this.src[this.pos];
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"') return this.parseString();
    if (ch === "-" || /[0-9]/.test(ch)) return this.parseNumber();
    return this.parseLiteral();
  }

  validate() {
    this.parseValue();
    this.skipWhitespace();
    if (this.pos < this.src.length) {
      throw new Error(`Trailing data after JSON at offset ${this.pos} in ${this.file}`);
    }
  }
}

const files = findJsonFiles(".");
let errors = 0;

for (const file of files) {
  try {
    const content = readFileSync(file, "utf-8");
    new JsonScanner(content, file).validate();
  } catch (err) {
    console.error(`\x1b[31m[json-lint]\x1b[0m ${err.message}`);
    errors++;
  }
}

if (errors > 0) {
  process.exit(1);
}

console.log(`Verified ${files.length} JSON files (0 syntax errors, 0 duplicate keys).`);
