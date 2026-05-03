"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * ErrorTracker — Sistema de rastreamento estruturado de erros para o Amarillo.
 *
 * Registra erros com contexto (componente, severidade, sessão) e persiste
 * em arquivo JSON para consulta futura via HTTP endpoint ou CLI.
 *
 * Níveis de severidade:
 *   "critical"  — Falha que impede o funcionamento do sistema
 *   "error"     — Falha de operação, mas o sistema continua
 *   "warning"   — Comportamento inesperado que não impede operação
 *   "info"      — Informação útil para debug
 */

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_LOG_FILE = "error-tracker.json";

class ErrorTracker {
  /**
   * @param {object} options
   * @param {string} options.workspaceRoot — Diretório base para persistir o log
   * @param {number} [options.maxEntries] — Máximo de entradas mantidas (FIFO)
   * @param {string} [options.logFileName] — Nome do arquivo de log
   * @param {boolean} [options.persistOnAdd] — Se true, salva no disco a cada erro adicionado
   */
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.logFileName = options.logFileName || DEFAULT_LOG_FILE;
    this.persistOnAdd = options.persistOnAdd !== false;
    this.entries = [];
    this._listeners = [];
    this._loadExisting();
  }

  /**
   * Caminho completo do arquivo de log.
   */
  get logFilePath() {
    return path.join(this.workspaceRoot, ".amarillo", this.logFileName);
  }

  /**
   * Registra um novo erro.
   *
   * @param {object} entry
   * @param {string} entry.component — Componente de origem (daemon, plugin, mcp-proxy, extension)
   * @param {string} entry.severity — "critical" | "error" | "warning" | "info"
   * @param {string} entry.code — Código identificador único do erro (ex: "ERR-001")
   * @param {string} entry.message — Mensagem descritiva do erro
   * @param {string} [entry.file] — Arquivo onde o erro ocorre
   * @param {number} [entry.line] — Linha do erro
   * @param {string} [entry.sessionId] — Sessão do Studio associada (se aplicável)
   * @param {string} [entry.projectId] — Projeto associado (se aplicável)
   * @param {object} [entry.context] — Dados adicionais de contexto
   * @param {string} [entry.suggestion] — Sugestão de correção
   * @param {boolean} [entry.resolved] — Se o erro já foi resolvido
   * @returns {object} O registro criado
   */
  add(entry) {
    const record = {
      id: this._generateId(),
      timestamp: new Date().toISOString(),
      component: entry.component || "unknown",
      severity: this._normalizeSeverity(entry.severity),
      code: entry.code || null,
      message: String(entry.message || "Unknown error"),
      file: entry.file || null,
      line: entry.line || null,
      sessionId: entry.sessionId || null,
      projectId: entry.projectId || null,
      context: entry.context || null,
      suggestion: entry.suggestion || null,
      resolved: entry.resolved === true,
      resolvedAt: null,
      stack: entry.stack || null
    };

    this.entries.unshift(record);

    // Trimmar entradas antigas
    while (this.entries.length > this.maxEntries) {
      this.entries.pop();
    }

    // Notificar listeners
    for (const listener of this._listeners) {
      try {
        listener(record);
      } catch (_error) {
        // Listener não pode crashar o tracker
      }
    }

    if (this.persistOnAdd) {
      this._persist();
    }

    return record;
  }

  /**
   * Atalho para registrar a partir de um Error object.
   */
  addFromError(error, options = {}) {
    return this.add({
      component: options.component || "daemon",
      severity: options.severity || "error",
      code: options.code || null,
      message: error.message || String(error),
      stack: error.stack || null,
      file: options.file || null,
      line: options.line || null,
      sessionId: options.sessionId || null,
      projectId: options.projectId || null,
      context: options.context || null,
      suggestion: options.suggestion || null
    });
  }

  /**
   * Marca um erro como resolvido.
   */
  resolve(entryId) {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) {
      return null;
    }
    entry.resolved = true;
    entry.resolvedAt = new Date().toISOString();
    if (this.persistOnAdd) {
      this._persist();
    }
    return entry;
  }

  /**
   * Marca todos os erros não resolvidos como resolvidos.
   */
  resolveAll() {
    const now = new Date().toISOString();
    let count = 0;
    for (const entry of this.entries) {
      if (!entry.resolved) {
        entry.resolved = true;
        entry.resolvedAt = now;
        count += 1;
      }
    }
    if (count > 0 && this.persistOnAdd) {
      this._persist();
    }
    return count;
  }

  /**
   * Remove todas as entradas.
   */
  clear() {
    this.entries = [];
    if (this.persistOnAdd) {
      this._persist();
    }
  }

  /**
   * Retorna entradas filtradas.
   *
   * @param {object} [filters]
   * @param {string} [filters.severity] — Filtrar por severidade
   * @param {string} [filters.component] — Filtrar por componente
   * @param {boolean} [filters.resolved] — Filtrar por status de resolução
   * @param {string} [filters.code] — Filtrar por código de erro
   * @param {string} [filters.sessionId] — Filtrar por sessão
   * @param {number} [filters.limit] — Limitar número de resultados
   * @param {string} [filters.since] — Filtrar por timestamp (ISO string)
   * @returns {object[]}
   */
  query(filters = {}) {
    let results = this.entries;

    if (filters.severity) {
      results = results.filter((e) => e.severity === filters.severity);
    }
    if (filters.component) {
      results = results.filter((e) => e.component === filters.component);
    }
    if (filters.resolved !== undefined) {
      results = results.filter((e) => e.resolved === filters.resolved);
    }
    if (filters.code) {
      results = results.filter((e) => e.code === filters.code);
    }
    if (filters.sessionId) {
      results = results.filter((e) => e.sessionId === filters.sessionId);
    }
    if (filters.since) {
      const sinceMs = Date.parse(filters.since);
      if (Number.isFinite(sinceMs)) {
        results = results.filter((e) => Date.parse(e.timestamp) >= sinceMs);
      }
    }
    if (filters.limit && filters.limit > 0) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  /**
   * Retorna um resumo estatístico.
   */
  summary() {
    const stats = {
      total: this.entries.length,
      unresolved: 0,
      resolved: 0,
      bySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      byComponent: {},
      recent: this.entries.slice(0, 10)
    };

    for (const entry of this.entries) {
      if (entry.resolved) {
        stats.resolved += 1;
      } else {
        stats.unresolved += 1;
      }
      stats.bySeverity[entry.severity] = (stats.bySeverity[entry.severity] || 0) + 1;
      stats.byComponent[entry.component] = (stats.byComponent[entry.component] || 0) + 1;
    }

    return stats;
  }

  /**
   * Registra um listener para novos erros.
   */
  onError(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter((listener) => listener !== callback);
    };
  }

  /**
   * Salva as entradas no disco.
   */
  persist() {
    this._persist();
  }

  // --- Internals ---

  _normalizeSeverity(severity) {
    const valid = ["critical", "error", "warning", "info"];
    return valid.includes(severity) ? severity : "error";
  }

  _generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `${timestamp}-${random}`;
  }

  _loadExisting() {
    try {
      if (fs.existsSync(this.logFilePath)) {
        const raw = fs.readFileSync(this.logFilePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.entries)) {
          this.entries = parsed.entries.slice(0, this.maxEntries);
        }
      }
    } catch (_error) {
      // Arquivo corrompido ou inexistente — começar vazio
      this.entries = [];
    }
  }

  _persist() {
    try {
      const dir = path.dirname(this.logFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        version: 1,
        generatedAt: new Date().toISOString(),
        totalEntries: this.entries.length,
        entries: this.entries
      };
      fs.writeFileSync(this.logFilePath, JSON.stringify(data, null, 2), "utf8");
    } catch (_error) {
      // Falha silenciosa na persistência — não crashar o daemon
    }
  }
}

module.exports = { ErrorTracker };
