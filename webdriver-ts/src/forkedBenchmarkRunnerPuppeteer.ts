import { Browser, CDPSession, Page } from "puppeteer-core";
import { BenchmarkType, CPUBenchmarkResult, slowDownFactor } from "./benchmarksCommon.js";
import { CPUBenchmarkPuppeteer, MemBenchmarkPuppeteer, BenchmarkPuppeteer, benchmarks } from "./benchmarksPuppeteer.js";
import {
  BenchmarkOptions,
  config as defaultConfig,
  ErrorAndWarning,
  FrameworkData,
  Config,
  wait,
} from "./common.js";
import { startBrowser } from "./puppeteerAccess.js";
import { computeResultsCPU, computeResultsJS, computeResultsPaint, fileNameTrace } from "./timeline.js";
import * as fs from "node:fs";

let config: Config = defaultConfig;

async function runBenchmark(page: Page, benchmark: BenchmarkPuppeteer, framework: FrameworkData): Promise<any> {
  await benchmark.run(page, framework);
  if (config.LOG_PROGRESS) console.log("after run", benchmark.benchmarkInfo.id, benchmark.type, framework.name);
}

async function initBenchmark(page: Page, benchmark: BenchmarkPuppeteer, framework: FrameworkData): Promise<any> {
  await benchmark.init(page, framework);
  if (config.LOG_PROGRESS) console.log("after initialized", benchmark.benchmarkInfo.id, benchmark.type, framework.name);
}

function convertError(error: any): string {
  console.log(
    "ERROR in run Benchmark: |",
    error,
    "| type:",
    typeof error,
    "instance of Error",
    error instanceof Error,
    "Message:",
    error.message
  );
  if (typeof error === "string") {
    console.log("Error is string");
    return error;
  } else if (error instanceof Error) {
    console.log("Error is instanceof Error");
    return error.message;
  } else {
    console.log("Error is unknown type");
    return error.toString();
  }
}

async function forceGC(page: Page) {
  await page.evaluate("window.gc({type:'major',execution:'sync',flavor:'last-resort'})");
}

async function runCPUBenchmark(
  framework: FrameworkData,
  benchmark: CPUBenchmarkPuppeteer,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<CPUBenchmarkResult>> {
  let warnings: string[] = [];
  let results: CPUBenchmarkResult[] = [];

  console.log("benchmarking", framework, benchmark.benchmarkInfo.id);
  let browser: Browser = null;
  // let page: Page = null;
  try {
    browser = await startBrowser(benchmarkOptions);
    // page = await browser.newPage();
    // if (config.LOG_DETAILS) {
    // page.on("console", (msg) => {
    //   for (let i = 0; i < msg.args().length; ++i) console.log(`BROWSER: ${msg.args()[i]}`);
    // });
    // }
    for (let i = 0; i < benchmarkOptions.batchSize; i++) {
      const page = await browser.newPage();
      page.on("console", (msg) => console.log("BROWSER:", ...msg.args()));
      try {
        await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
          waitUntil: "networkidle0",
        });
      } catch (error) {
        console.log("**** loading benchmark failed, retrying");
        await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
          waitUntil: "networkidle0",
        });
      }

      // await (driver as any).sendDevToolsCommand('Network.enable');
      // await (driver as any).sendDevToolsCommand('Network.emulateNetworkConditions', {
      //     offline: false,
      //     latency: 200, // ms
      //     downloadThroughput: 780 * 1024 / 8, // 780 kb/s
      //     uploadThroughput: 330 * 1024 / 8, // 330 kb/s
      // });

      console.log("initBenchmark");
      await initBenchmark(page, benchmark, framework);

      // let categories = ["blink.user_timing", "devtools.timeline", "disabled-by-default-devtools.timeline"];
      // "blink", "cc","toplevel","v8","benchmark","gpu","viz"
      let categories = [
        "disabled-by-default-v8.cpu_profiler",
        "blink.user_timing",
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
      ];

      // let categories = [
      //   "-*", // exclude default
      //   "toplevel",
      //   "v8.execute",
      //   "blink.console",
      //   "blink.user_timing",
      //   "benchmark",
      //   "loading",
      //   "latencyInfo",
      //   "devtools.timeline",
      //   "disabled-by-default-devtools.timeline",
      //   "disabled-by-default-devtools.timeline.frame",
      //   "disabled-by-default-devtools.timeline.stack",
      //   "disabled-by-default-devtools.screenshot",
      // ];

      let throttleCPU = slowDownFactor(benchmark.benchmarkInfo.id, benchmarkOptions.allowThrottling);
      if (throttleCPU) {
        console.log("CPU slowdown", throttleCPU);
        await page.emulateCPUThrottling(throttleCPU);
      }

      await page.tracing.start({
        path: fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions),
        screenshots: false,
        categories: categories,
      });
      await wait(50);

      await forceGC(page);

      console.log("runBenchmark");
      // let m1 = await page.metrics();

      await runBenchmark(page, benchmark, framework);

      await wait(100);
      await page.tracing.stop();
      // let m2 = await page.metrics();
      if (throttleCPU) {
        await page.emulateCPUThrottling(1);
      }

      // console.log("afterBenchmark", m1, m2);
      // let result = (m2.TaskDuration - m1.TaskDuration)*1000.0; //await computeResultsCPU(fileNameTrace(framework, benchmark, i), benchmarkOptions, framework, benchmark, warnings, benchmarkOptions.batchSize);
      try {
        let result = await computeResultsCPU(fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions), framework.startLogicEventName);
        let resultScript = await computeResultsJS(
          result,
          config,
          fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions)
        );
        let resultPaint = await computeResultsPaint(
          result,
          config,
          fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions)
        );
        console.log("**** resultScript =", resultScript);
        // if (m2.Timestamp == m1.Timestamp) throw new Error("Page metrics timestamp didn't change");
        results.push({ total: result.duration, script: resultScript, paint: resultPaint });
        console.log(`duration for ${framework.name} and ${benchmark.benchmarkInfo.id}: ${JSON.stringify(result)}`);
        if (result.duration < 0) throw new Error(`duration ${result} < 0`);
      } catch (error) {
        if (error === "exactly one click event is expected") {
          let fileName = fileNameTrace(framework, benchmark.benchmarkInfo, i, benchmarkOptions);
          let errorFileName = fileName.replace(/\//, "/error-");
          fs.copyFileSync(fileName, errorFileName);
          console.log(
            "*** Repeating run because of 'exactly one click event is expected' error",
            fileName,
            "saved in",
            errorFileName
          );
          i--;

          continue;
        } else {
          console.log("*** Unhandled error:", error);
          throw error;
        }
      } finally {
        await page.close();
      }
    }
    return { error: undefined, warnings, result: results };
  } catch (error) {
    console.log("ERROR", error);
    return { error: convertError(error), warnings };
  } finally {
    try {
      if (browser) {
        console.log("*** browser close");
        await browser.close();
        console.log("*** browser closed");
      }
    } catch (error) {
      console.log("ERROR cleaning up driver", error);
    }
    console.log("*** browser has been shutting down");
  }
}

async function runMemBenchmark(
  framework: FrameworkData,
  benchmark: MemBenchmarkPuppeteer,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<number>> {
  let error: string = undefined;
  let warnings: string[] = [];
  let results: number[] = [];

  console.log("benchmarking", framework, benchmark.benchmarkInfo.id);
  let browser: Browser = null;
  try {
    browser = await startBrowser(benchmarkOptions);
    const page = await browser.newPage();
    for (let i = 0; i < benchmarkOptions.batchSize; i++) {
      if (config.LOG_DETAILS) {
        page.on("console", (msg) => {
          for (let i = 0; i < msg.args().length; ++i) console.log(`BROWSER: ${msg.args()[i]}`);
        });
      }

      await page.goto(`http://${benchmarkOptions.host}:${benchmarkOptions.port}/${framework.uri}/index.html`, {
        waitUntil: "networkidle0",
      });

      // await (driver as any).sendDevToolsCommand('Network.enable');
      // await (driver as any).sendDevToolsCommand('Network.emulateNetworkConditions', {
      //     offline: false,
      //     latency: 200, // ms
      //     downloadThroughput: 780 * 1024 / 8, // 780 kb/s
      //     uploadThroughput: 330 * 1024 / 8, // 330 kb/s
      // });
      console.log("initBenchmark");
      await initBenchmark(page, benchmark, framework);
      const client = await page.createCDPSession();

      console.log("runBenchmark");
      await runBenchmark(page, benchmark, framework);
      await forceGC(page);
      await wait(40);
      let result = ((await page.evaluate("performance.measureUserAgentSpecificMemory()")) as any).bytes / 1024 / 1024;
      console.log("afterBenchmark");

      results.push(result);
      console.log(`memory result for ${framework.name} and ${benchmark.benchmarkInfo.id}: ${result}`);

      // await client.send('Performance.enable');
      // let cdpMetrics = await client.send('Performance.getMetrics');
      // let response = cdpMetrics.metrics.filter((m) => m.name==='JSHeapUsedSize')[0].value
      // console.log("Performance.getMetrics", response, response/1024/1024);

      // await wait(10 * 1000 * 1000 * 60);

      if (result < 0) throw new Error(`memory result ${result} < 0`);
    }
    await page.close();
    await browser.close();
    return { error, warnings, result: results };
  } catch (error) {
    console.log("ERROR", error);
    try {
      if (browser) {
        await browser.close();
      }
    } catch (error) {
      console.log("ERROR cleaning up driver", error);
    }
    return { error: convertError(error), warnings };
  }
}

export async function executeBenchmark(
  framework: FrameworkData,
  benchmarkId: string,
  benchmarkOptions: BenchmarkOptions
): Promise<ErrorAndWarning<any>> {
  let runBenchmarks: Array<BenchmarkPuppeteer> = benchmarks.filter(
    (b) =>
      benchmarkId === b.benchmarkInfo.id && (b instanceof CPUBenchmarkPuppeteer || b instanceof MemBenchmarkPuppeteer)
  ) as Array<BenchmarkPuppeteer>;
  if (runBenchmarks.length != 1) throw `Benchmark name ${benchmarkId} is not unique (puppeteer)`;

  let benchmark = runBenchmarks[0];

  let errorAndWarnings: ErrorAndWarning<any>;
  if (benchmark.type == BenchmarkType.CPU) {
    errorAndWarnings = await runCPUBenchmark(framework, benchmark as CPUBenchmarkPuppeteer, benchmarkOptions);
  } else {
    errorAndWarnings = await runMemBenchmark(framework, benchmark as MemBenchmarkPuppeteer, benchmarkOptions);
  }
  if (config.LOG_DEBUG) console.log("benchmark finished - got errors promise", errorAndWarnings);
  return errorAndWarnings;
}

process.on("message", (msg: any) => {
  config = msg.config;
  console.log("START BENCHMARK. Write results?", config.WRITE_RESULTS);
  // if (config.LOG_DEBUG) console.log("child process got message", msg);

  let {
    framework,
    benchmarkId,
    benchmarkOptions,
  }: {
    framework: FrameworkData;
    benchmarkId: string;
    benchmarkOptions: BenchmarkOptions;
  } = msg;
  defaultConfig.PUPPETEER_WAIT_MS = benchmarkOptions.puppeteerSleep;
  console.log("forked runner using sleep for puppeteer", config.PUPPETEER_WAIT_MS);
  executeBenchmark(framework, benchmarkId, benchmarkOptions)
    .then((result) => {
      process.send(result);
      process.exit(0);
    })
    .catch((error) => {
      console.log("CATCH: Error in forkedBenchmarkRunner");
      process.send({ error: convertError(error) });
      process.exit(0);
    });
});
