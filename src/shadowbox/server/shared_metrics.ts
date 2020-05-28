// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {http, https} from 'follow-redirects';

import {Clock} from '../infrastructure/clock';
import {JsonConfig} from '../infrastructure/json_config';
import * as logging from '../infrastructure/logging';
import {PrometheusClient} from '../infrastructure/prometheus_scraper';
import {AccessKeyId, AccessKeyMetricsId} from '../model/access_key';
import {version} from '../package.json';

import {ServerConfigJson} from './server_config';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const SANCTIONED_COUNTRIES = new Set(['CU', 'KP', 'SY']);

// Used internally to track key usage.
export interface KeyUsage {
  accessKeyId: string;
  countries: string[];
  inboundBytes: number;
}

// JSON format for the published report.
// Field renames will break backwards-compatibility.
export interface HourlyServerMetricsReportJson {
  serverId: string;
  startUtcMs: number;
  endUtcMs: number;
  userReports: HourlyUserMetricsReportJson[];
}

// JSON format for the published report.
// Field renames will break backwards-compatibility.
export interface HourlyUserMetricsReportJson {
  userId: string;
  countries: string[];
  bytesTransferred: number;
}

// JSON format for the feature metrics report.
// Field renames will break backwards-compatibility.
export interface DailyFeatureMetricsReportJson {
  serverId: string;
  serverVersion: string;
  timestampUtcMs: number;
  dataLimit: DailyDataLimitMetricsReportJson;
}

// JSON format for the data limit feature metrics report.
// Field renames will break backwards-compatibility.
export interface DailyDataLimitMetricsReportJson {
  enabled: boolean;
}

export interface SharedMetricsPublisher {
  startSharing();
  stopSharing();
  isSharingEnabled();
}

export interface UsageMetrics {
  getUsage(): Promise<KeyUsage[]>;
  reset();
}

// Reads data usage metrics from Prometheus.
export class PrometheusUsageMetrics implements UsageMetrics {
  private resetTimeMs: number = Date.now();

  constructor(private prometheusClient: PrometheusClient) {}

  async getUsage(): Promise<KeyUsage[]> {
    const timeDeltaSecs = Math.round((Date.now() - this.resetTimeMs) / 1000);
    // We measure the traffic to and from the target, since that's what we are protecting.
    const result =
        await this.prometheusClient.query(`sum(increase(shadowsocks_data_bytes{dir=~"p>t|p<t"}[${
            timeDeltaSecs}s])) by (location, access_key)`);
    const usage = [] as KeyUsage[];
    for (const entry of result.result) {
      const accessKeyId = entry.metric['access_key'] || '';
      let countries = [];
      const countriesStr = entry.metric['location'] || '';
      if (countriesStr) {
        countries = countriesStr.split(',').map((e) => e.trim());
      }
      const inboundBytes = Math.round(parseFloat(entry.value[1]));
      usage.push({accessKeyId, countries, inboundBytes});
    }
    return usage;
  }

  reset() {
    this.resetTimeMs = Date.now();
  }
}

export interface MetricsCollectorClient {
  collectServerUsageMetrics(reportJson: HourlyServerMetricsReportJson): Promise<void>;
  collectFeatureMetrics(reportJson: DailyFeatureMetricsReportJson): Promise<void>;
}

export class RestMetricsCollectorClient {
  constructor(private serviceUrl: string) {}

  collectServerUsageMetrics(reportJson: HourlyServerMetricsReportJson): Promise<void> {
    return this.postMetrics('/connections', JSON.stringify(reportJson));
  }

  collectFeatureMetrics(reportJson: DailyFeatureMetricsReportJson): Promise<void> {
    return this.postMetrics('/features', JSON.stringify(reportJson));
  }

  private postMetrics(urlPath: string, reportJson: string): Promise<void> {
    const url = new URL(this.serviceUrl);
    let requestModule = https;
    if (url.protocol === 'http') {
      requestModule = http;
    }
    const options = {
      hostname: url.hostname,
      path: urlPath,
      headers: {'Content-Type': 'application/json', 'Content-Length': reportJson.length},
      method: 'POST'
    };
    logging.info(`Posting metrics to ${this.serviceUrl}${urlPath}: ${reportJson}`);
    return new Promise((resolve, reject) => {
      const req = requestModule.request(options, (res) => {
        const statusCode = res.statusCode;
        if (statusCode >= 200 && statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`metrics server request failed with status code ${statusCode}`));
        }
      });
      req.on('error', (e) => {
        reject(e);
      });
      req.write(reportJson);
      req.end();
    });
  }
}

// Keeps track of the connection metrics per user, since the startDatetime.
// This is reported to the Outline team if the admin opts-in.
export class OutlineSharedMetricsPublisher implements SharedMetricsPublisher {
  // Time at which we started recording connection metrics.
  private reportStartTimestampMs: number;

  // serverConfig: where the enabled/disable setting is persisted
  // usageMetrics: where we get the metrics from
  // toMetricsId: maps Access key ids to metric ids
  // metricsUrl: where to post the metrics
  constructor(
      private clock: Clock, private serverConfig: JsonConfig<ServerConfigJson>,
      usageMetrics: UsageMetrics,
      private toMetricsId: (accessKeyId: AccessKeyId) => AccessKeyMetricsId,
      private metricsCollector: MetricsCollectorClient) {
    // Start timer
    this.reportStartTimestampMs = this.clock.now();

    this.clock.setInterval(async () => {
      if (!this.isSharingEnabled()) {
        return;
      }
      try {
        await this.reportServerUsageMetrics(await usageMetrics.getUsage());
        usageMetrics.reset();
      } catch (err) {
        console.error(`Failed to report server usage metrics: ${err}`);
      }
    }, MS_PER_HOUR);
    // TODO(fortuna): also trigger report on shutdown, so data loss is minimized.

    this.clock.setInterval(async () => {
      if (!this.isSharingEnabled()) {
        return;
      }
      try {
        await this.reportFeatureMetrics();
      } catch (err) {
        console.error(`Failed to report feature metrics: ${err}`);
      }
    }, MS_PER_DAY);
  }

  startSharing() {
    this.serverConfig.data().metricsEnabled = true;
    this.serverConfig.write();
  }

  stopSharing() {
    this.serverConfig.data().metricsEnabled = false;
    this.serverConfig.write();
  }

  isSharingEnabled(): boolean {
    return this.serverConfig.data().metricsEnabled || false;
  }

  private async reportServerUsageMetrics(usageMetrics: KeyUsage[]): Promise<void> {
    const reportEndTimestampMs = this.clock.now();

    const userReports = [] as HourlyUserMetricsReportJson[];
    for (const keyUsage of usageMetrics) {
      if (keyUsage.inboundBytes === 0) {
        continue;
      }
      if (hasSanctionedCountry(keyUsage.countries)) {
        continue;
      }
      userReports.push({
        userId: this.toMetricsId(keyUsage.accessKeyId) || '',
        bytesTransferred: keyUsage.inboundBytes,
        countries: [...keyUsage.countries]
      });
    }
    const report = {
      serverId: this.serverConfig.data().serverId,
      startUtcMs: this.reportStartTimestampMs,
      endUtcMs: reportEndTimestampMs,
      userReports
    } as HourlyServerMetricsReportJson;

    this.reportStartTimestampMs = reportEndTimestampMs;
    if (userReports.length === 0) {
      return;
    }
    await this.metricsCollector.collectServerUsageMetrics(report);
  }

  private async reportFeatureMetrics(): Promise<void> {
    const featureMetricsReport = {
      serverId: this.serverConfig.data().serverId,
      serverVersion: version,
      timestampUtcMs: this.clock.now(),
      dataLimit: {enabled: !!this.serverConfig.data().accessKeyDataLimit},
    };
    await this.metricsCollector.collectFeatureMetrics(featureMetricsReport);
  }
}

function hasSanctionedCountry(countries: string[]) {
  for (const country of countries) {
    if (SANCTIONED_COUNTRIES.has(country)) {
      return true;
    }
  }
  return false;
}