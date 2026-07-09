import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputPath = path.join(rootDir, "data", "releases.json");
const scriptOutputPath = path.join(rootDir, "data", "releases.js");

const config = {
  region: process.env.REGION || "KR",
  language: process.env.LANGUAGE || "ko-KR",
  pastDays: readNumber("PAST_DAYS", 7),
  futureDays: readNumber("FUTURE_DAYS", 180),
  maxPages: readNumber("MAX_PAGES", 8),
  concurrency: readNumber("CONCURRENCY", 5),
  allowEmpty: process.env.ALLOW_EMPTY === "true",
  bearerToken: process.env.TMDB_BEARER_TOKEN || "",
  apiKey: process.env.TMDB_API_KEY || ""
};

const today = stripTime(new Date());
const startDate = formatDate(addDays(today, -config.pastDays));
const endDate = formatDate(addDays(today, config.futureDays));
const hasTmdbCredential = Boolean(config.bearerToken || config.apiKey);
const allowedOttProviders = new Map([
  ["netflix", "Netflix"],
  ["netflixstandardwithads", "Netflix"],
  ["wavve", "Wavve"],
  ["wave", "Wavve"],
  ["tving", "TVING"],
  ["disneyplus", "Disney+"],
  ["disney+", "Disney+"],
  ["watcha", "Watcha"],
  ["laftel", "Laftel"]
]);

const releasePlans = [
  {
    channel: "theater",
    releaseTypes: [2, 3],
    discoverReleaseType: "2|3"
  },
  {
    channel: "ott",
    releaseTypes: [4],
    discoverReleaseType: "4"
  }
];

const build = hasTmdbCredential ? await buildFromTmdbApi() : await buildFromPublicPages();
const items = build.items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, "ko"));
if (!items.length && !config.allowEmpty) {
  throw new Error(`No release items were collected for ${config.region} between ${startDate} and ${endDate}. Refusing to publish an empty calendar.`);
}

const output = {
  generatedAt: new Date().toISOString(),
  region: config.region,
  language: config.language,
  source: build.source,
  window: { startDate, endDate },
  attribution: build.attribution,
  items
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
await writeFile(scriptOutputPath, `window.RELEASE_DATA = ${JSON.stringify(output, null, 2)};\n`, "utf8");

console.log(`Wrote ${items.length} real release items from ${build.source} for ${config.region} (${startDate}..${endDate}).`);
console.log(outputPath);
console.log(scriptOutputPath);

async function buildFromTmdbApi() {
  const rows = [];
  for (const plan of releasePlans) {
    const movies = await discoverMovies(plan);
    const enriched = await mapLimit(movies, config.concurrency, (movie) => enrichMovie(movie, plan));
    rows.push(...enriched.filter(Boolean));
  }

  return {
    source: "tmdb-api",
    attribution: [
      "This product uses the TMDB API but is not endorsed or certified by TMDB.",
      "OTT availability data is provided by JustWatch through TMDB where available."
    ],
    items: dedupe(rows)
  };
}

async function buildFromPublicPages() {
  const [nowPlaying, upcoming, justwatch] = await Promise.all([
    scrapeTmdbList("https://www.themoviedb.org/movie/now-playing", "theater"),
    scrapeTmdbList("https://www.themoviedb.org/movie/upcoming", "theater"),
    scrapeJustWatchNewMovies()
  ]);

  return {
    source: "tmdb-public",
    attribution: [
      "Theater release data is collected from public TMDB pages.",
      "OTT new-release data is collected from public JustWatch Korea pages."
    ],
    items: dedupe([...nowPlaying, ...upcoming, ...justwatch])
  };
}

async function scrapeTmdbList(baseUrl, channel) {
  const pages = Math.min(config.maxPages, 2);
  const cards = [];
  for (let page = 1; page <= pages; page += 1) {
    const url = new URL(baseUrl);
    url.searchParams.set("language", config.language);
    url.searchParams.set("region", config.region);
    url.searchParams.set("page", String(page));
    const html = await fetchText(url);
    cards.push(...parseTmdbCards(html, channel));
  }

  const uniqueCards = [...new Map(cards.map((card) => [`${card.channel}:${card.tmdbId}`, card])).values()];
  const enriched = await mapLimit(uniqueCards, config.concurrency, enrichTmdbPublicCard);
  return enriched.filter(Boolean);
}

function parseTmdbCards(html, channel) {
  const cards = [];
  const cardPattern = /<a class="flex w-full"[^>]+href="(?<href>\/movie\/(?<tmdbId>\d+)[^"]*)"[^]*?<img alt="(?<imageAlt>[^"]*)"[^>]+src="(?<poster>https:\/\/media\.themoviedb\.org\/[^"]+)"[^]*?<a class="font-normal[^>]+href="[^"]+"[^]*?<span>(?<title>[^<]+)<\/span><\/h2><\/a><\/div><span class="subheader[^"]*">(?<dateLabel>[^<]+)<\/span>/g;
  for (const match of html.matchAll(cardPattern)) {
    const date = parseTmdbKoreanDate(match.groups.dateLabel);
    if (!date || date < startDate || date > endDate) continue;
    cards.push({
      tmdbId: match.groups.tmdbId,
      title: decodeHtml(match.groups.title),
      channel,
      date,
      posterPath: decodeHtml(match.groups.poster),
      tmdbUrl: `https://www.themoviedb.org${match.groups.href}`
    });
  }
  return cards;
}

async function enrichTmdbPublicCard(card) {
  try {
    const detailUrl = new URL(card.tmdbUrl);
    detailUrl.searchParams.set("language", config.language);
    const html = await fetchText(detailUrl);
    const facts = html.match(/<div class="facts">(?<facts>[^]*?)<\/div>/)?.groups?.facts || "";
    const metaDescription = html.match(/<meta name="description" content="(?<description>[^"]*)"/)?.groups?.description || "";
    const runtimeLabel = facts.match(/<span class="runtime">\s*(?<runtime>[^<]+?)\s*<\/span>/)?.groups?.runtime || "";
    const detailReleaseDate = facts.match(/<span class="release">\s*(?<release>[^<]+?)\s*<\/span>/)?.groups?.release?.slice(0, 10).replaceAll("/", "-");
    const releaseDate = detailReleaseDate >= startDate && detailReleaseDate <= endDate ? detailReleaseDate : card.date;
    const genres = [...facts.matchAll(/<a href="\/genre\/[^"]+">(?<genre>[^<]+)<\/a>/g)].map((match) => decodeHtml(match.groups.genre));
    const rating = decodeHtml(facts.match(/<span class="certification">\s*(?<rating>[^<]+?)\s*<\/span>/)?.groups?.rating || "");
    const backdropPath = html.match(/background-image: url\('(?<backdrop>https:\/\/media\.themoviedb\.org\/[^']+)'\)/)?.groups?.backdrop || "";

    return {
      id: `theater-${card.tmdbId}-${releaseDate || card.date}`,
      tmdbId: Number(card.tmdbId),
      title: card.title,
      originalTitle: "",
      channel: "theater",
      date: releaseDate || card.date,
      runtime: parseRuntime(runtimeLabel),
      rating,
      genres,
      overview: decodeHtml(metaDescription),
      providers: [],
      posterPath: card.posterPath,
      backdropPath,
      tmdbUrl: card.tmdbUrl
    };
  } catch (error) {
    return {
      id: `theater-${card.tmdbId}-${card.date}`,
      tmdbId: Number(card.tmdbId),
      title: card.title,
      originalTitle: "",
      channel: "theater",
      date: card.date,
      runtime: null,
      rating: "",
      genres: [],
      overview: "",
      providers: [],
      posterPath: card.posterPath,
      backdropPath: "",
      tmdbUrl: card.tmdbUrl
    };
  }
}

async function scrapeJustWatchNewMovies() {
  const html = await fetchText("https://www.justwatch.com/kr/new?content_type=movie");
  const frames = [];
  const framePattern = /<div class="timeline__timeframe--(?<date>\d{4}-\d{2}-\d{2}) timeline__timeframe">/g;
  const matches = [...html.matchAll(framePattern)];

  for (let index = 0; index < matches.length; index += 1) {
    const date = matches[index].groups.date;
    if (date < startDate || date > endDate) continue;
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? html.length;
    frames.push({ date, html: html.slice(start, end) });
  }

  const rows = [];
  for (const frame of frames) {
    const providerParts = frame.html.split("provider-timeline__logo").slice(1);
    for (const part of providerParts) {
      const provider = decodeHtml(part.match(/<img class="square small provider-icon"[^>]+alt="(?<provider>[^"]+)"/)?.groups?.provider || "");
      if (!provider || provider === "JustWatch") continue;
      const normalizedProvider = normalizeOttProvider(provider);
      if (!normalizedProvider) continue;
      const titlePattern = /<a href="(?<href>\/kr\/영화\/[^"]+)"[^]*?<img class="picture-comp__img" alt="(?<title>[^"]+)" src="(?<poster>https:\/\/images\.justwatch\.com\/[^"]+)"/g;
      for (const match of part.matchAll(titlePattern)) {
        const title = decodeHtml(match.groups.title);
        const href = decodeHtml(match.groups.href);
        const slug = href.split("/").pop();
        rows.push({
          id: `ott-${slug}-${frame.date}-${provider.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          justwatchPath: href,
          title,
          originalTitle: "",
          channel: "ott",
          date: frame.date,
          runtime: null,
          rating: "",
          genres: [],
          overview: `JustWatch 기준 ${normalizedProvider}에 새로 추가된 영화입니다.`,
          providers: [normalizedProvider],
          posterPath: decodeHtml(match.groups.poster),
          backdropPath: "",
          tmdbUrl: `https://www.justwatch.com${href}`
        });
      }
    }
  }
  return mergeOttProviders(rows);
}

async function discoverMovies(plan) {
  const collected = [];
  for (let page = 1; page <= config.maxPages; page += 1) {
    const data = await tmdb("/discover/movie", {
      language: config.language,
      region: config.region,
      "release_date.gte": startDate,
      "release_date.lte": endDate,
      with_release_type: plan.discoverReleaseType,
      include_adult: "false",
      include_video: "false",
      sort_by: "primary_release_date.asc",
      page: String(page)
    });

    collected.push(...(data.results || []));
    const lastPage = Math.min(data.total_pages || 1, config.maxPages);
    if (page >= lastPage) break;
  }
  return collected;
}

async function enrichMovie(movie, plan) {
  const [details, releaseInfo, providers] = await Promise.all([
    tmdb(`/movie/${movie.id}`, { language: config.language }),
    findReleaseInfo(movie.id, plan.releaseTypes),
    plan.channel === "ott" ? findWatchProviders(movie.id) : Promise.resolve([])
  ]);

  if (!releaseInfo.date || releaseInfo.date < startDate || releaseInfo.date > endDate) return null;
  if (plan.channel === "ott" && !providers.length) return null;

  return {
    id: `${plan.channel}-${movie.id}-${releaseInfo.date}`,
    tmdbId: movie.id,
    title: details.title || movie.title || movie.original_title || "",
    originalTitle: details.original_title || movie.original_title || "",
    channel: plan.channel,
    date: releaseInfo.date,
    runtime: details.runtime || null,
    rating: releaseInfo.rating || "",
    genres: (details.genres || []).map((genre) => genre.name).filter(Boolean),
    overview: details.overview || movie.overview || "",
    providers,
    posterPath: details.poster_path || movie.poster_path || "",
    backdropPath: details.backdrop_path || movie.backdrop_path || "",
    tmdbUrl: `https://www.themoviedb.org/movie/${movie.id}`
  };
}

async function findReleaseInfo(movieId, releaseTypes) {
  const data = await tmdb(`/movie/${movieId}/release_dates`);
  const country = (data.results || []).find((entry) => entry.iso_3166_1 === config.region);
  const releases = country?.release_dates || [];
  const matches = releases
    .filter((release) => releaseTypes.includes(release.type))
    .map((release) => ({
      date: release.release_date?.slice(0, 10) || "",
      rating: release.certification || ""
    }))
    .filter((release) => release.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  return matches[0] || { date: "", rating: "" };
}

async function findWatchProviders(movieId) {
  const data = await tmdb(`/movie/${movieId}/watch/providers`);
  const regionData = data.results?.[config.region];
  const buckets = ["flatrate", "rent", "buy", "free", "ads"];
  const names = buckets.flatMap((bucket) => regionData?.[bucket]?.map((provider) => provider.provider_name) || []);
  return [...new Set(names.map(normalizeOttProvider).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
}

async function tmdb(endpoint, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  if (config.apiKey && !config.bearerToken) url.searchParams.set("api_key", config.apiKey);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      headers: config.bearerToken ? { Authorization: `Bearer ${config.bearerToken}` } : {}
    });

    if (response.ok) return response.json();
    if (response.status === 429 && attempt < 3) {
      await sleep(1000 * attempt);
      continue;
    }

    const text = await response.text();
    throw new Error(`TMDB ${response.status} ${endpoint}: ${text}`);
  }
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) {
    const stableId = row.tmdbId || row.justwatchPath || row.id || row.title;
    map.set(`${row.channel}:${stableId}:${row.date}`, row);
  }
  return [...map.values()];
}

function mergeOttProviders(rows) {
  const map = new Map();
  for (const row of rows) {
    row.providers = [...new Set(row.providers.map(normalizeOttProvider).filter(Boolean))];
    if (!row.providers.length) continue;
    const key = `${row.justwatchPath}:${row.date}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      continue;
    }
    existing.providers = [...new Set([...existing.providers, ...row.providers])].sort((a, b) => a.localeCompare(b, "ko"));
    existing.id = `ott-${row.justwatchPath.split("/").pop()}-${row.date}`;
    existing.overview = `JustWatch 기준 ${existing.providers.join(", ")}에 새로 추가된 영화입니다.`;
  }
  return [...map.values()];
}

function normalizeOttProvider(provider) {
  const normalized = String(provider || "").toLowerCase().replace(/[^a-z0-9+]+/g, "");
  return allowedOttProviders.get(normalized) || "";
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
      "user-agent": "Mozilla/5.0 (compatible; ReleaseCalendarBot/1.0)"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.text();
}

function parseTmdbKoreanDate(label) {
  const cleaned = decodeHtml(label).trim();
  const match = cleaned.match(/(?<month>\d{1,2})월\s*(?<day>\d{1,2}),\s*(?<year>\d{4})/);
  if (!match) return "";
  return `${match.groups.year}-${match.groups.month.padStart(2, "0")}-${match.groups.day.padStart(2, "0")}`;
}

function parseRuntime(label) {
  const cleaned = decodeHtml(label).trim();
  if (!cleaned) return null;
  const hours = Number(cleaned.match(/(?<hours>\d+)h/)?.groups?.hours || 0);
  const minutes = Number(cleaned.match(/(?<minutes>\d+)m/)?.groups?.minutes || 0);
  const total = hours * 60 + minutes;
  return total || null;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function readNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
