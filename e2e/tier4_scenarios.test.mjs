import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  DEMO_HTML_PATH,
  assertValidPng,
  assertValidSvg,
  countLines,
  loadPublicApi,
  requireExport,
} from "./_helpers.mjs";

describe("Tier 4: Real-World End-to-End Scenarios", () => {
  it("full discovery workflow: ORIGINAL_6 misses counterexamples caught by DEFAULT (all registry axes) and renders vision artifacts", async () => {
    const api = await loadPublicApi();
    const buildCorpus = requireExport(api, "buildCorpus");
    const runDiscoveryLoop = requireExport(api, "runDiscoveryLoop");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const extractAudioProfile = requireExport(api, "extractAudioProfile");
    const ORIGINAL_6_FALSIFIERS = requireExport(api, "ORIGINAL_6_FALSIFIERS");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");
    const renderTextVision = requireExport(api, "renderTextVision");
    const renderSvgVision = requireExport(api, "renderSvgVision");
    const renderPngVision = requireExport(api, "renderPngVision");

    const corpus = buildCorpus({ sampleRate: 24000, seed: 2026 });
    assert.ok(Array.isArray(corpus.positives) && corpus.positives.length >= 8);
    assert.ok(
      Array.isArray(corpus.counterexamples) && corpus.counterexamples.length >= 20
    );

    const discovery = runDiscoveryLoop({ sampleRate: 24000, seed: 2026 });
    assert.ok(discovery && typeof discovery === "object");

    // Verify slip-throughs: items missed by ORIGINAL_6 but caught by DEFAULT (all registry axes)
    let caughtByCore = 0;
    let caughtByAll = 0;
    let slipThroughItem = null;
    let slipThroughReport = null;

    for (const item of corpus.counterexamples) {
      const optsCore = {
        label: item.id,
        falsifiers: ORIGINAL_6_FALSIFIERS,
        policy: "veto_all",
        ...(item.channels ? { channels: item.channels } : {}),
      };
      const optsAll = {
        label: item.id,
        falsifiers: DEFAULT_FALSIFIERS,
        policy: "veto_all",
        ...(item.channels ? { channels: item.channels } : {}),
      };
      const rCore = analyzeSamples(item.samples, item.sampleRate, optsCore);
      const rAll = analyzeSamples(item.samples, item.sampleRate, optsAll);
      if (rCore.verdict === "REJECTED_UNKAWAII") caughtByCore++;
      if (rAll.verdict === "REJECTED_UNKAWAII") caughtByAll++;
      if (
        !slipThroughItem &&
        rCore.verdict === "SURVIVED_KAWAII_CANDIDATE" &&
        rAll.verdict === "REJECTED_UNKAWAII"
      ) {
        slipThroughItem = item;
        slipThroughReport = rAll;
      }
    }

    assert.ok(
      caughtByAll > caughtByCore,
      `Expected DEFAULT (all registry axes) (${caughtByAll}) to catch strictly more counterexamples than ORIGINAL_6 (${caughtByCore})`
    );
    assert.ok(
      slipThroughItem,
      "Expected at least one counterexample that slips through ORIGINAL_6 and is caught by DEFAULT (all registry axes)"
    );

    // Inspect caught slip-through counterexample via text, SVG, and PNG vision
    const profile = extractAudioProfile(
      slipThroughItem.samples,
      slipThroughItem.sampleRate,
      slipThroughItem.channels ? { channels: slipThroughItem.channels } : {}
    );
    const textVision = renderTextVision(profile, slipThroughReport, { mode: "compact" });
    assert.ok(textVision.trim().length > 0 && countLines(textVision) <= 32);

    const svgVision = renderSvgVision(profile, slipThroughReport);
    assertValidSvg(svgVision);

    const pngVision = renderPngVision(profile, slipThroughReport);
    assertValidPng(pngVision);
  });

  it("positive controls survival: all >= 8 diverse pleasant/kawaii controls survive with 0 veto", async () => {
    const api = await loadPublicApi();
    const buildCorpus = requireExport(api, "buildCorpus");
    const analyzeSamples = requireExport(api, "analyzeSamples");
    const DEFAULT_FALSIFIERS = requireExport(api, "DEFAULT_FALSIFIERS");

    const corpus = buildCorpus({ sampleRate: 24000, seed: 2026 });
    assert.ok(
      Array.isArray(corpus.positives) && corpus.positives.length >= 8,
      `Expected >= 8 positive controls, got ${corpus.positives?.length}`
    );

    const failures = [];
    for (const item of corpus.positives) {
      const report = analyzeSamples(item.samples, item.sampleRate, {
        label: item.id,
        falsifiers: DEFAULT_FALSIFIERS,
        policy: "veto_all",
        ...(item.channels ? { channels: item.channels } : {}),
      });
      if (
        report.verdict !== "SURVIVED_KAWAII_CANDIDATE" ||
        report.triggeredCount !== 0
      ) {
        const triggered = report.falsifiers
          .filter((f) => f.triggered)
          .map((f) => `${f.id}(${f.score.toFixed(2)})`)
          .join(", ");
        failures.push(`${item.id}: ${report.verdict} [${triggered}]`);
      }
    }

    assert.equal(
      failures.length,
      0,
      `Positive controls should survive with 0 veto falsifiers, but failed: ${failures.join("; ")}`
    );
  });

  it("audition HTML demo is self-contained, playable, showcases survivors, A/B judge UI, and LLM vision", () => {
    assert.ok(
      fs.existsSync(DEMO_HTML_PATH),
      `Audition demo HTML missing at ${DEMO_HTML_PATH}`
    );
    const html = fs.readFileSync(DEMO_HTML_PATH, "utf8");

    // 1. Self-contained: zero external http(s) <script src> or <link href>
    assert.ok(
      !/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(html),
      "Audition demo must not load external scripts via http(s)"
    );
    assert.ok(
      !/<link\b[^>]*\bhref\s*=\s*["']https?:\/\//i.test(html),
      "Audition demo must not load external stylesheets/links via http(s)"
    );

    // 2. Playable embedded audio: valid RIFF/WAVE data URI(s) or Web Audio API synthesis
    const wavUriMatch = html.match(/data:audio\/wav;base64,([A-Za-z0-9+/=]+)/);
    const hasWebAudio = /\b(AudioContext|webkitAudioContext)\b/.test(html);
    assert.ok(
      Boolean(wavUriMatch) || hasWebAudio,
      "Audition demo must include embedded WAV data URIs or Web Audio playback"
    );
    if (wavUriMatch) {
      const wavBuf = Buffer.from(wavUriMatch[1], "base64");
      assert.ok(wavBuf.length >= 44, "Decoded embedded WAV payload too short");
      assert.equal(
        wavBuf.toString("ascii", 0, 4),
        "RIFF",
        "Embedded WAV data URI must start with RIFF header"
      );
      assert.equal(
        wavBuf.toString("ascii", 8, 12),
        "WAVE",
        "Embedded WAV data URI must contain WAVE format marker"
      );
    }

    // 3. SURVIVED_KAWAII_CANDIDATE showcase
    assert.match(
      html,
      /SURVIVED_KAWAII_CANDIDATE/,
      "Audition demo must include SURVIVED_KAWAII_CANDIDATE showcase"
    );

    // 4. A/B counterexample comparison + human judge controls
    assert.match(
      html,
      /(でかした|すり抜けた|judge|ジャッジ)/i,
      "Audition demo must include human judge controls"
    );
    assert.match(
      html,
      /(copy|コピー|clipboard)/i,
      "Audition demo must include copy-log capability for human judge feedback"
    );
    assert.match(
      html,
      /<button\b/i,
      "Audition demo must include interactive buttons"
    );

    // 5. LLM vision views (static <svg>/<pre> panels OR dynamic JS-rendered vision views)
    const hasStaticVision =
      /<svg\b[\s\S]*?<\/svg>/i.test(html) || /<pre\b[\s\S]*?<\/pre>/i.test(html);
    const hasDynamicVision =
      /createElementNS\s*\(\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(html) ||
      /<svg\b/i.test(html) ||
      /<pre\b/i.test(html) ||
      /\brenderTextVision\b/i.test(html) ||
      /\bclass\s*=\s*["'][^"']*vision[^"']*["']/i.test(html);
    assert.ok(
      hasStaticVision || hasDynamicVision,
      "Audition demo must include static or dynamically rendered LLM vision panels (<svg>, <pre>, createElementNS, or vision renderer)"
    );
  });
});
