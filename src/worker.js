// src/worker.js

const SERIES_KEY = "series";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
};

function parseSeriesArray(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) {
      // normalize missing fields
      return arr.map((s) => ({
        id: String(s.id),
        title: s.title,
        year: s.year ?? null,
        rating: typeof s.rating === "number" ? s.rating : 0,
        watched:
          typeof s.watched === "number" && s.watched >= 0 ? s.watched : 0,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

function serializeSeriesArray(arr) {
  return JSON.stringify(arr, null, 2);
}

function toSeriesTxt(arr) {
  return arr
    .map((s) => (s.year ? `${s.title} — ${s.year}` : `${s.title}`))
    .join("\n");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    try {
      if (pathname.startsWith("/api/tmdb")) {
        return handleTmdb(request, env, searchParams);
      }

      if (pathname === "/api/series" || pathname.startsWith("/api/series/")) {
        return handleSeries(request, env, pathname);
      }

      if (pathname === "/api/series.txt") {
        return handleSeriesTxt(env);
      }

      return new Response("Not found", {
        status: 404,
        headers: CORS_HEADERS,
      });
    } catch (e) {
      return jsonResponse({ error: e.message || String(e) }, 500);
    }
  },
};

async function handleTmdb(request, env, searchParams) {
  const q = searchParams.get("q");
  const year = searchParams.get("year");

  if (!q) {
    return jsonResponse({ error: "Missing q" }, 400);
  }

  const apiKey = env.TMDB_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "TMDB_API_KEY not set" }, 500);
  }

  const tmdbUrl = new URL("https://api.themoviedb.org/3/search/tv");
  tmdbUrl.searchParams.set("api_key", apiKey);
  tmdbUrl.searchParams.set("query", q);
  if (year) tmdbUrl.searchParams.set("first_air_date_year", year);

  const res = await fetch(tmdbUrl.toString());
  if (!res.ok) {
    return jsonResponse({ error: "TMDB lookup failed" }, 500);
  }

  const data = await res.json();
  const item = data.results?.[0];

  if (!item) {
    return jsonResponse({ error: "No results" }, 404);
  }

  const detailUrl = new URL(`https://api.themoviedb.org/3/tv/${item.id}`);
  detailUrl.searchParams.set("api_key", apiKey);

  const detailRes = await fetch(detailUrl.toString());
  const detail = detailRes.ok ? await detailRes.json() : {};

  const normalized = {
    id: item.id,
    name: item.name,
    overview: item.overview || "",
    date: item.first_air_date || "",
    vote_average: item.vote_average || null,
    status: detail.status || "",
    networks: (detail.networks || []).map((n) => n.name),
    poster_path: item.poster_path || null,
    number_of_episodes: detail.number_of_episodes ?? null,
    tmdbUrl: `https://www.themoviedb.org/tv/${item.id}`,
  };

  return jsonResponse(normalized);
}

async function handleSeries(request, env, pathname) {
  const raw = await env.SERIES_KV.get(SERIES_KEY);
  let series = parseSeriesArray(raw);

  const method = request.method.toUpperCase();

  // /api/series
  if (pathname === "/api/series") {
    if (method === "GET") {
      return jsonResponse({ items: series });
    }

    if (method === "POST") {
      const body = await request.json().catch(() => ({}));
      const title = (body.title || "").trim();
      const yearRaw = body.year;
      const year =
        yearRaw === null || yearRaw === undefined || yearRaw === ""
          ? null
          : Number(yearRaw);

      if (!title) {
        return jsonResponse({ error: "Title is required" }, 400);
      }
      if (year !== null && (!Number.isInteger(year) || year < 1900)) {
        return jsonResponse({ error: "Invalid year" }, 400);
      }

      const id = crypto.randomUUID();
      const item = { id, title, year, rating: 0, watched: 0 };
      series.push(item);

      await env.SERIES_KV.put(SERIES_KEY, serializeSeriesArray(series));
      return jsonResponse({ item }, 201);
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // /api/series/:id
  const parts = pathname.split("/");
  const id = parts[3];
  const idx = series.findIndex((s) => s.id === id);
  if (idx === -1) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  if (method === "PUT" || method === "PATCH") {
    const body = await request.json().catch(() => ({}));

    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) return jsonResponse({ error: "Invalid title" }, 400);
      series[idx].title = t;
    }

    if (body.year !== undefined) {
      if (body.year === null || body.year === "") {
        series[idx].year = null;
      } else {
        const y = Number(body.year);
        if (!Number.isInteger(y) || y < 1900) {
          return jsonResponse({ error: "Invalid year" }, 400);
        }
        series[idx].year = y;
      }
    }

    if (body.rating !== undefined) {
      let r = Number(body.rating);
      if (!Number.isFinite(r) || r < 0) r = 0;
      if (r > 5) r = 5;
      series[idx].rating = r;
    }

    if (body.watched !== undefined) {
      let w = Number(body.watched);
      if (!Number.isFinite(w) || w < 0) w = 0;
      series[idx].watched = w;
    }

    await env.SERIES_KV.put(SERIES_KEY, serializeSeriesArray(series));
    return jsonResponse({ item: series[idx] });
  }

  if (method === "DELETE") {
    series = series.filter((s) => s.id !== id);
    await env.SERIES_KV.put(SERIES_KEY, serializeSeriesArray(series));
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}

async function handleSeriesTxt(env) {
  const raw = await env.SERIES_KV.get(SERIES_KEY);
  const series = parseSeriesArray(raw);
  const text = toSeriesTxt(series);

  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}
