/*
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {bindReporter} from './lib/bindReporter.js';
import {onBFCacheRestore} from './lib/bfcache.js';
import {doubleRAF} from './lib/doubleRAF.js';
import {initMetric} from './lib/initMetric.js';
import {observe} from './lib/observe.js';
import {onHidden} from './lib/onHidden.js';
import {runOnce} from './lib/runOnce.js';
import {getSoftNavigationEntry, softNavs} from './lib/softNavs.js';
import {onFCP} from './onFCP.js';
import {
  CLSMetric,
  CLSReportCallback,
  Metric,
  MetricRatingThresholds,
  ReportOpts,
} from './types.js';

/** Thresholds for CLS. See https://web.dev/articles/cls#what_is_a_good_cls_score */
export const CLSThresholds: MetricRatingThresholds = [0.1, 0.25];

/**
 * Calculates the [CLS](https://web.dev/articles/cls) value for the current page and
 * calls the `callback` function once the value is ready to be reported, along
 * with all `layout-shift` performance entries that were used in the metric
 * value calculation. The reported value is a `double` (corresponding to a
 * [layout shift score](https://web.dev/articles/cls#layout_shift_score)).
 *
 * If the `reportAllChanges` configuration option is set to `true`, the
 * `callback` function will be called as soon as the value is initially
 * determined as well as any time the value changes throughout the page
 * lifespan.
 *
 * _**Important:** CLS should be continually monitored for changes throughout
 * the entire lifespan of a page—including if the user returns to the page after
 * it's been hidden/backgrounded. However, since browsers often [will not fire
 * additional callbacks once the user has backgrounded a
 * page](https://developer.chrome.com/blog/page-lifecycle-api/#advice-hidden),
 * `callback` is always called when the page's visibility state changes to
 * hidden. As a result, the `callback` function might be called multiple times
 * during the same page load._
 */
export const onCLS = (onReport: CLSReportCallback, opts?: ReportOpts) => {
  // Set defaults
  opts = opts || {};
  const softNavsEnabled = softNavs(opts);
  let reportedMetric = false;
  let metricNavStartTime = 0;

  // Start monitoring FCP so we can only report CLS if FCP is also reported.
  // Note: this is done to match the current behavior of CrUX.
  onFCP(
    runOnce(() => {
      let metric = initMetric('CLS', 0);
      let report: ReturnType<typeof bindReporter>;

      let sessionValue = 0;
      let sessionEntries: LayoutShift[] = [];

      const initNewCLSMetric = (
        navigation?: Metric['navigationType'],
        navigationId?: string,
      ) => {
        metric = initMetric('CLS', 0, navigation, navigationId);
        report = bindReporter(
          onReport,
          metric,
          CLSThresholds,
          opts!.reportAllChanges,
        );
        sessionValue = 0;
        reportedMetric = false;
        if (navigation === 'soft-navigation') {
          const softNavEntry = getSoftNavigationEntry(navigationId);
          metricNavStartTime = softNavEntry ? softNavEntry.startTime || 0 : 0;
        }
      };

      const handleEntries = (entries: LayoutShift[]) => {
        entries.forEach((entry) => {
          // If the entry is for a new navigationId than previous, then we have
          // entered a new soft nav, so emit the final LCP and reinitialize the
          // metric.
          if (
            softNavsEnabled &&
            entry.navigationId &&
            entry.navigationId !== metric.navigationId
          ) {
            // If the current session value is larger than the current CLS value,
            // update CLS and the entries contributing to it.
            if (sessionValue > metric.value) {
              metric.value = sessionValue;
              metric.entries = sessionEntries;
            }
            report(true);
            initNewCLSMetric('soft-navigation', entry.navigationId);
          }

          // Only count layout shifts without recent user input.
          if (!entry.hadRecentInput) {
            const firstSessionEntry = sessionEntries[0];
            const lastSessionEntry = sessionEntries[sessionEntries.length - 1];

            // If the entry occurred less than 1 second after the previous entry
            // and less than 5 seconds after the first entry in the session,
            // include the entry in the current session. Otherwise, start a new
            // session.
            if (
              sessionValue &&
              entry.startTime - lastSessionEntry.startTime < 1000 &&
              entry.startTime - firstSessionEntry.startTime < 5000
            ) {
              sessionValue += entry.value;
              sessionEntries.push(entry);
            } else {
              sessionValue = entry.value;
              sessionEntries = [entry];
            }
          }
        });

        // If the current session value is larger than the current CLS value,
        // update CLS and the entries contributing to it.
        if (sessionValue > metric.value) {
          metric.value = sessionValue;
          metric.entries = sessionEntries;
          report();
        }
      };

      const po = observe('layout-shift', handleEntries, opts);
      if (po) {
        report = bindReporter(
          onReport,
          metric,
          CLSThresholds,
          opts!.reportAllChanges,
        );

        onHidden(() => {
          handleEntries(po.takeRecords() as CLSMetric['entries']);
          report(true);
          reportedMetric = true;
        });

        // Only report after a bfcache restore if the `PerformanceObserver`
        // successfully registered.
        onBFCacheRestore(() => {
          initNewCLSMetric('back-forward-cache', metric.navigationId);
          doubleRAF(() => report());
        });

        // Soft navs may be detected by navigationId changes in metrics above
        // But where no metric is issued we need to also listen for soft nav
        // entries, then emit the final metric for the previous navigation and
        // reset the metric for the new navigation.
        //
        // As PO is ordered by time, these should not happen before metrics.
        //
        // We add a check on startTime as we may be processing many entries that
        // are already dealt with so just checking navigationId differs from
        // current metric's navigation id, as we did above, is not sufficient.
        const handleSoftNavEntries = (entries: SoftNavigationEntry[]) => {
          entries.forEach((entry) => {
            const navId = entry.navigationId;
            const softNavEntry = navId ? getSoftNavigationEntry(navId) : null;
            if (
              navId &&
              navId !== metric.navigationId &&
              softNavEntry &&
              (softNavEntry.startTime || 0) > metricNavStartTime
            ) {
              if (!reportedMetric) report(true);
              initNewCLSMetric('soft-navigation', entry.navigationId);
              report = bindReporter(
                onReport,
                metric,
                CLSThresholds,
                opts!.reportAllChanges,
              );
            }
          });
        };

        if (softNavsEnabled) {
          observe('soft-navigation', handleSoftNavEntries, opts);
        }

        // Queue a task to report (if nothing else triggers a report first).
        // This allows CLS to be reported as soon as FCP fires when
        // `reportAllChanges` is true.
        setTimeout(report, 0);
      }
    }),
  );
};
