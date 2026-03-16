import path from "node:path";

import { readJson, writeJson } from "../core/utils.js";

export class ReportWriter {
  constructor({ config }) {
    this.config = config;
  }

  reportFile(rollbackId) {
    return path.join(this.config.reportsDir, `${rollbackId}.json`);
  }

  async save(report) {
    await writeJson(this.reportFile(report.rollbackId), report);
    return report;
  }

  async get(rollbackId) {
    return readJson(this.reportFile(rollbackId), null);
  }
}
