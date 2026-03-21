import path from "node:path";

import { readJsonRecords } from "../core/persistence.js";
import { readJson, removePath, writeJson } from "../core/utils.js";

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

  async list() {
    return (await readJsonRecords(this.config.reportsDir))
      .filter((report) => report?.rollbackId);
  }

  async remove(rollbackId) {
    const current = await this.get(rollbackId);

    if (!current) {
      return null;
    }

    await removePath(this.reportFile(rollbackId));
    return current;
  }
}
