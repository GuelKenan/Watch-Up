const DB_NAME = "watch-up-db";
const STORE = "titles";
const SUGGESTION_STORE = "suggestions";
const TMDB_KEY = "watch-up-tmdb-key";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w780";
const statuses = [
  "Will ich sehen",
  "Schaue ich gerade",
  "Pausiert",
  "Abgeschlossen",
  "Abgebrochen",
  "Rewatch"
];

const state = {
  titles: [],
  view: "library",
  kind: "all",
  status: "all",
  search: "",
  swipeMode: "unwatched",
  swipeIndex: 0,
  newSuggestions: [],
  savedSuggestions: [],
  discoverySeed: "mix",
  calendarDate: new Date()
};

const titleSuggestionCache = new Map();
let titleSearchTimer;
let titleSearchRun = 0;
let formEpisodes = [];
let selectedSeason = null;
let swipeStartX = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SUGGESTION_STORE)) {
        database.createObjectStore(SUGGESTION_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(mode = "readonly", storeName = STORE) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function getAllTitles() {
  return new Promise((resolve, reject) => {
    const request = transaction().getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
  });
}

function getAllSavedSuggestions() {
  return new Promise((resolve, reject) => {
    const request = transaction("readonly", SUGGESTION_STORE).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error);
  });
}

function saveTitle(title) {
  return new Promise((resolve, reject) => {
    const request = transaction("readwrite").put(title);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function saveSuggestion(suggestion) {
  return new Promise((resolve, reject) => {
    const request = transaction("readwrite", SUGGESTION_STORE).put(suggestion);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteTitle(id) {
  return new Promise((resolve, reject) => {
    const request = transaction("readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function deleteTitleEverywhere(id) {
  const title = state.titles.find((item) => item.id === id);
  if (title) {
    title.includeInCalendar = false;
    title.plannedAt = "";
    title.releaseDate = "";
    (title.episodes || []).forEach((episode) => {
      episode.plannedAt = "";
    });
  }
  if ($("#planTitleSelect")?.value === id) {
    $("#planTitleSelect").value = "";
    $("#planEpisodeSelect").innerHTML = `<option value="">-</option>`;
    $("#planDateInput").value = "";
  }
  await deleteTitle(id);
}

function deleteSuggestion(id) {
  return new Promise((resolve, reject) => {
    const request = transaction("readwrite", SUGGESTION_STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function refresh() {
  state.titles = await getAllTitles();
  state.savedSuggestions = dedupeMedia(await getAllSavedSuggestions());
  renderLibrary();
  renderStats();
  renderCalendar();
  renderSwipe();
}

function splitTags(value) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function formatTags(tags = []) {
  return tags.join(", ");
}

function normalizeRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

function statusClass(status) {
  return status.toLowerCase().replaceAll(" ", "-");
}

function titleInitials(title = "") {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]).join("");
  return (initials || "WU").toUpperCase();
}

function normalizeTitleKey(title = "") {
  return String(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(film|movie|the movie|der film|die serie|series|tv series)\b/g, " ")
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mediaYear(item = {}) {
  const year = String(item.year || item.raw?.year || item.rawSuggestion?.year || "").match(/\b(19|20)\d{2}\b/)?.[0] || "";
  return year;
}

function mediaIdentity(item = {}) {
  const type = item.type || item.raw?.type || "movie";
  const title = item.title || item.raw?.title || "";
  const year = mediaYear(item);
  return `${type}:${normalizeTitleKey(title)}:${year}`;
}

function isSameMedia(a = {}, b = {}) {
  const aType = a.type || a.raw?.type || "movie";
  const bType = b.type || b.raw?.type || "movie";
  if (aType !== bType) return false;
  if (normalizeTitleKey(a.title || a.raw?.title) !== normalizeTitleKey(b.title || b.raw?.title)) return false;
  const aYear = mediaYear(a);
  const bYear = mediaYear(b);
  return !aYear || !bYear || aYear === bYear;
}

function suggestionQuality(item = {}) {
  const sourceScore = { tmdb: 6, jikan: 5, tvmaze: 5, wikidata: 4, itunes: 3, new: 2 };
  return (item.poster || item.image ? 20 : 0)
    + (item.description || item.raw?.description || item.rawSuggestion?.description ? 4 : 0)
    + (item.year || item.raw?.year || item.rawSuggestion?.year ? 2 : 0)
    + (sourceScore[item.source] || 0);
}

function dedupeMedia(items = []) {
  const unique = [];
  items.forEach((item) => {
    const duplicateIndex = unique.findIndex((candidate) => isSameMedia(candidate, item));
    if (duplicateIndex === -1) {
      unique.push(item);
      return;
    }
    if (suggestionQuality(item) > suggestionQuality(unique[duplicateIndex])) {
      unique[duplicateIndex] = item;
    }
  });
  return unique;
}

function hasMediaInList(list = [], item = {}) {
  return list.some((candidate) => isSameMedia(candidate, item));
}

function getWatchedEpisodes(title) {
  return (title.episodes || []).filter((episode) => episode.seen);
}

function getTitleRewatchCount(title) {
  return Math.max(0, Number(title.rewatchCount || 0));
}

function getMinutes(title) {
  if (title.type === "movie") {
    const baseWatch = title.status === "Abgeschlossen" || title.status === "Rewatch" || title.watchedAt ? 1 : 0;
    return (baseWatch + getTitleRewatchCount(title)) * Number(title.runtime || 0);
  }
  const watchedEpisodes = getWatchedEpisodes(title);
  return watchedEpisodes.reduce((sum, episode) => sum + Number(episode.runtime || title.runtime || 0), 0)
    + getTitleRewatchCount(title) * (title.episodes || []).reduce((sum, episode) => sum + Number(episode.runtime || title.runtime || 0), 0);
}

function getMovieMinutes() {
  return state.titles
    .filter((title) => title.type === "movie")
    .reduce((sum, title) => sum + getMinutes(title), 0);
}

function getSeriesMinutes() {
  return state.titles
    .filter((title) => title.type === "series")
    .reduce((sum, title) => sum + getMinutes(title), 0);
}

function monthLabel(dateValue) {
  if (!dateValue) return "ohne Datum";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "ohne Datum";
  return date.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
}

function todayIso() {
  return toIsoDate(new Date());
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getWatchEvents() {
  const events = [];
  state.titles.forEach((title) => {
    if (title.type === "movie" && (title.watchedAt || title.status === "Abgeschlossen" || title.status === "Rewatch")) {
      events.push({
        date: title.watchedAt || "",
        label: title.title,
        detail: "Film",
        minutes: Number(title.runtime || 0),
        rating: title.rating
      });
    }

    (title.episodes || []).forEach((episode) => {
      if (!episode.seen) return;
      events.push({
        date: episode.watchedAt || "",
        label: title.title,
        detail: `S${episode.season || 1} E${episode.number || "?"} · ${episode.name || "Episode"}`,
        minutes: Number(episode.runtime || title.runtime || 0),
        rating: episode.rating
      });
    });
  });
  return events.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function isWatchedTitle(title) {
  if (title.type === "movie") return title.status === "Abgeschlossen" || title.status === "Rewatch" || Boolean(title.watchedAt);
  return getWatchedEpisodes(title).length > 0 || title.status === "Abgeschlossen" || title.status === "Rewatch";
}

function isAnimeTitle(title = {}) {
  const haystack = [
    title.title,
    title.source,
    ...(title.genres || []),
    ...(title.moods || [])
  ].join(" ").toLowerCase();
  return haystack.includes("anime") || haystack.includes("myanimelist") || title.malId;
}

function normalizeWords(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9äöüß\s:']/gi, " ").split(/\s+/).filter((word) => word.length > 2);
}

function getTasteProfile() {
  const liked = state.titles.filter((title) => Number(title.rating || 0) >= 7 || isWatchedTitle(title));
  const genreCounts = {};
  const moodCounts = {};
  const castCounts = {};
  liked.forEach((title) => {
    (title.genres || []).forEach((genre) => { genreCounts[genre] = (genreCounts[genre] || 0) + (Number(title.rating || 7)); });
    (title.moods || []).forEach((mood) => { moodCounts[mood] = (moodCounts[mood] || 0) + (Number(title.rating || 7)); });
    (title.cast || []).forEach((person) => { castCounts[person] = (castCounts[person] || 0) + (Number(title.rating || 7)); });
  });
  return {
    genres: Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).map(([genre]) => genre),
    moods: Object.entries(moodCounts).sort((a, b) => b[1] - a[1]).map(([mood]) => mood),
    cast: Object.entries(castCounts).sort((a, b) => b[1] - a[1]).map(([person]) => person),
    likedTitles: liked
  };
}

function recommendationReasons(candidate, profile) {
  const reasons = [];
  const genreMatch = (candidate.genres || []).filter((genre) => profile.genres.includes(genre));
  const moodMatch = (candidate.moods || []).filter((mood) => profile.moods.includes(mood));
  const castMatch = (candidate.cast || []).filter((person) => profile.cast.includes(person));
  if (genreMatch.length) reasons.push(`Genre passt: ${genreMatch.slice(0, 2).join(", ")}`);
  if (moodMatch.length) reasons.push(`Mood passt: ${moodMatch.slice(0, 2).join(", ")}`);
  if (castMatch.length) reasons.push(`Besetzung passt: ${castMatch.slice(0, 2).join(", ")}`);

  const candidateWords = normalizeWords(candidate.title);
  const related = profile.likedTitles.find((title) => {
    if (title.id === candidate.id) return false;
    const titleWords = normalizeWords(title.title);
    return candidateWords.some((word) => titleWords.includes(word));
  });
  if (related) reasons.push(`ähnlich oder gleiche Reihe wie ${related.title}`);
  if (!reasons.length) reasons.push("aus deiner Sammlung");
  return reasons;
}

function scoreCandidate(candidate, profile) {
  let score = 0;
  (candidate.genres || []).forEach((genre) => { if (profile.genres.includes(genre)) score += 3; });
  (candidate.moods || []).forEach((mood) => { if (profile.moods.includes(mood)) score += 2; });
  (candidate.cast || []).forEach((person) => { if (profile.cast.includes(person)) score += 4; });
  if (Number(candidate.rating || 0) >= 7) score += 2;
  if (candidate.status === "Will ich sehen") score += 1;
  return score;
}

function getSwipeCandidates() {
  const profile = getTasteProfile();
  if (state.swipeMode === "new") return state.newSuggestions;
  const candidates = state.titles.filter((title) => {
    if (state.swipeMode === "rewatch") return isWatchedTitle(title);
    return !isWatchedTitle(title) && title.status !== "Abgebrochen";
  });
  return candidates
    .map((title) => ({ ...title, reasons: recommendationReasons(title, profile), score: scoreCandidate(title, profile) }))
    .sort((a, b) => b.score - a.score);
}

function renderSwipe() {
  const candidates = getSwipeCandidates();
  const current = candidates[state.swipeIndex] || null;
  $("#swipeYesBtn").textContent = state.swipeMode === "new" ? "Merken" : "Ja";
  $("#swipeMaybeBtn").textContent = state.swipeMode === "new" ? "Später" : "Vielleicht";
  $("#recommendationList").innerHTML = candidates.length
    ? candidates.slice(0, 8).map((item) => listItem(item.title, (item.reasons || ["passt zu dir"])[0])).join("")
    : emptyLine(state.swipeMode === "new" ? "Wähle ein Genre und lade neue Vorschläge" : "Keine passenden Titel");
  renderSavedSuggestions();

  if (!current) {
    const emptyText = state.swipeMode === "new"
      ? "Lade neue Vorschläge oder wähle oben ein Genre."
      : "In diesem Bereich sind gerade keine passenden Titel.";
    $("#swipeDeck").innerHTML = `<div class="swipe-empty"><h3>Keine Karte</h3><p>${emptyText}</p></div>`;
    $("#swipeHint").textContent = state.swipeMode === "new" ? "Noch keine neuen Vorschläge geladen." : "Keine weiteren Karten.";
    return;
  }

  const currentPoster = safeImageUrl(current.poster);
  const poster = currentPoster
    ? `<div class="swipe-poster"><img src="${escapeHtml(currentPoster)}" alt="" referrerpolicy="no-referrer"></div>`
    : `<div class="swipe-poster poster-placeholder"><span>${current.type === "movie" ? "Film" : "Serie"}</span><strong>${escapeHtml(titleInitials(current.title))}</strong></div>`;
  $("#swipeDeck").innerHTML = `
    <article class="swipe-card">
      ${poster}
      <div class="swipe-info">
        <span class="status">${current.type === "movie" ? "Film" : "Serie"}</span>
        <h3>${escapeHtml(current.title)}</h3>
        <p>${escapeHtml((current.reasons || ["passt zu dir"]).join(" · "))}</p>
        <div class="card-tags">${[...(current.genres || []), ...(current.moods || [])].slice(0, 4).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
        <small class="swipe-tip">Nach links nein, nach rechts ja</small>
      </div>
    </article>
  `;
  $("#swipeHint").textContent = `${state.swipeIndex + 1}/${candidates.length}`;
}

function renderSavedSuggestions() {
  const list = $("#savedSuggestionList");
  if (!list) return;
  list.innerHTML = state.savedSuggestions.length
    ? state.savedSuggestions.map((suggestion) => `
      <div class="saved-suggestion">
        <div>
          <strong>${escapeHtml(suggestion.title)}</strong>
          <span>${escapeHtml(suggestion.type === "movie" ? "Film" : "Serie")} · ${escapeHtml(suggestion.year || "ohne Jahr")}</span>
        </div>
        <div class="saved-actions">
          <button class="secondary" data-add-suggestion="${suggestion.id}">Zur Sammlung</button>
          <button class="danger" data-delete-suggestion="${suggestion.id}">Entfernen</button>
        </div>
      </div>
    `).join("")
    : emptyLine("Noch keine neuen Vorschläge angenommen");
}

const discoverySeedMap = {
  mix: ["action", "comedy", "drama", "thriller", "science fiction", "fantasy", "romance", "crime"],
  action: ["action", "adventure"],
  comedy: ["comedy"],
  drama: ["drama"],
  thriller: ["thriller", "mystery"],
  horror: ["horror"],
  scifi: ["science fiction", "sci-fi"],
  fantasy: ["fantasy"],
  romance: ["romance"],
  anime: ["anime"]
};

const curatedDiscoverPool = [
  { type: "movie", title: "Mad Max: Fury Road", year: "2015", genres: ["Action", "Adventure", "Sci-Fi"] },
  { type: "movie", title: "John Wick", year: "2014", genres: ["Action", "Thriller"] },
  { type: "movie", title: "Mission: Impossible - Fallout", year: "2018", genres: ["Action", "Adventure"] },
  { type: "movie", title: "The Nice Guys", year: "2016", genres: ["Comedy", "Crime"] },
  { type: "movie", title: "Knives Out", year: "2019", genres: ["Mystery", "Comedy", "Crime"] },
  { type: "movie", title: "The Grand Budapest Hotel", year: "2014", genres: ["Comedy", "Drama"] },
  { type: "movie", title: "Parasite", year: "2019", genres: ["Drama", "Thriller"] },
  { type: "movie", title: "Whiplash", year: "2014", genres: ["Drama", "Music"] },
  { type: "movie", title: "Gone Girl", year: "2014", genres: ["Thriller", "Mystery"] },
  { type: "movie", title: "Prisoners", year: "2013", genres: ["Thriller", "Crime", "Drama"] },
  { type: "movie", title: "Hereditary", year: "2018", genres: ["Horror", "Drama"] },
  { type: "movie", title: "Get Out", year: "2017", genres: ["Horror", "Thriller"] },
  { type: "movie", title: "Arrival", year: "2016", genres: ["Sci-Fi", "Drama"] },
  { type: "movie", title: "Dune", year: "2021", genres: ["Sci-Fi", "Adventure"] },
  { type: "movie", title: "The Lord of the Rings: The Fellowship of the Ring", year: "2001", genres: ["Fantasy", "Adventure"] },
  { type: "movie", title: "Stardust", year: "2007", genres: ["Fantasy", "Romance", "Adventure"] },
  { type: "movie", title: "Pride & Prejudice", year: "2005", genres: ["Romance", "Drama"] },
  { type: "movie", title: "About Time", year: "2013", genres: ["Romance", "Comedy", "Drama"] },
  { type: "series", title: "Breaking Bad", year: "2008", genres: ["Drama", "Crime", "Thriller"] },
  { type: "series", title: "Better Call Saul", year: "2015", genres: ["Drama", "Crime"] },
  { type: "series", title: "Dark", year: "2017", genres: ["Sci-Fi", "Mystery", "Drama"] },
  { type: "series", title: "Stranger Things", year: "2016", genres: ["Sci-Fi", "Horror", "Drama"] },
  { type: "series", title: "The Bear", year: "2022", genres: ["Drama", "Comedy"] },
  { type: "series", title: "Fleabag", year: "2016", genres: ["Comedy", "Drama"] },
  { type: "series", title: "True Detective", year: "2014", genres: ["Crime", "Drama", "Mystery"] },
  { type: "series", title: "Severance", year: "2022", genres: ["Sci-Fi", "Thriller", "Drama"] },
  { type: "series", title: "The Last of Us", year: "2023", genres: ["Drama", "Horror", "Adventure"] },
  { type: "series", title: "The Witcher", year: "2019", genres: ["Fantasy", "Action", "Adventure"] },
  { type: "series", title: "Attack on Titan", year: "2013", genres: ["Anime", "Action", "Drama"] },
  { type: "series", title: "Death Note", year: "2006", genres: ["Anime", "Thriller", "Mystery"] },
  { type: "series", title: "Fullmetal Alchemist: Brotherhood", year: "2009", genres: ["Anime", "Fantasy", "Adventure"] },
  { type: "movie", title: "Spirited Away", year: "2001", genres: ["Anime", "Fantasy", "Adventure"] },
  { type: "movie", title: "Your Name", year: "2016", genres: ["Anime", "Romance", "Fantasy"] }
];

function curatedSuggestionsForSeed(seed, existingTitles) {
  const wanted = discoverySeedMap[seed] || discoverySeedMap.mix;
  const wantedLower = wanted.map((item) => item.toLowerCase().replace("science fiction", "sci-fi"));
  return curatedDiscoverPool
    .filter((item) => seed === "mix" || item.genres.some((genre) => wantedLower.includes(genre.toLowerCase())))
    .filter((item) => !hasMediaInList(existingTitles, item))
    .map((item) => ({
      id: `curated-${item.type}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      source: "new",
      type: item.type,
      title: item.title,
      year: item.year,
      genres: item.genres,
      cast: [],
      moods: [],
      poster: "",
      description: "",
      reasons: [`kuratierter ${seed === "mix" ? "Genre-Mix" : "Vorschlag"} · ${item.genres.slice(0, 2).join(", ")}`]
    }));
}

async function enrichSuggestionImages(suggestions) {
  const enriched = await Promise.all(suggestions.slice(0, 20).map(async (suggestion) => {
    if (suggestion.poster) return suggestion;
    const details = await fetchWikipediaDetails(suggestion.title, suggestion.type).catch(() => ({ image: "", extract: "" }));
    return {
      ...suggestion,
      poster: details.image || suggestion.poster || "",
      description: suggestion.description || details.extract || ""
    };
  }));
  return [...enriched, ...suggestions.slice(20)];
}

async function searchItunesMovies(query) {
  const countries = ["DE", "US"];
  const results = [];
  const seen = new Set();
  for (const country of countries) {
    const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=movie&entity=movie&limit=10&country=${country}`);
    if (!response.ok) continue;
    const data = await response.json();
    (data.results || []).forEach((movie) => {
      const title = movie.trackName || "";
      const key = title.toLowerCase();
      if (!title || seen.has(key)) return;
      seen.add(key);
      results.push({
        source: "itunes",
        id: String(movie.trackId),
        type: "movie",
        title,
        year: movie.releaseDate ? movie.releaseDate.slice(0, 4) : "",
        genres: [movie.primaryGenreName || "Film"],
        cast: [],
        moods: [],
        poster: (movie.artworkUrl100 || "").replace("100x100bb", "600x600bb"),
        description: movie.longDescription || movie.shortDescription || "",
        reasons: [`Filmvorschlag aus ${query}`]
      });
    });
  }
  return results;
}

async function loadNewSuggestions() {
  const profile = getTasteProfile();
  const baseSeeds = discoverySeedMap[state.discoverySeed] || discoverySeedMap.mix;
  const titleSeeds = profile.likedTitles.slice(0, 3).map((title) => `${title.title} film`).filter(Boolean);
  const movieSeeds = state.discoverySeed === "mix"
    ? [...baseSeeds.slice(0, 4), ...titleSeeds]
    : [...baseSeeds, ...titleSeeds.slice(0, 1)];
  const seriesSeeds = state.discoverySeed === "mix"
    ? [...baseSeeds.slice(0, 5), ...profile.genres.slice(0, 2)]
    : baseSeeds;
  const existingTitles = [...state.titles, ...state.savedSuggestions];
  const suggestions = curatedSuggestionsForSeed(state.discoverySeed, existingTitles);
  $("#swipeHint").textContent = "Neue Vorschläge werden gesucht...";

  for (const seed of movieSeeds.length ? movieSeeds : discoverySeedMap.mix) {
    const [tmdbMovies, itunesMovies, wikidataMovies] = await Promise.allSettled([
      searchTmdbDiscover(seed, "movie"),
      searchItunesMovies(seed),
      searchWikidataMovies(seed)
    ]);
    const movies = [
      ...(tmdbMovies.status === "fulfilled" ? tmdbMovies.value : []),
      ...(itunesMovies.status === "fulfilled" ? itunesMovies.value : []),
      ...(wikidataMovies.status === "fulfilled" ? wikidataMovies.value : [])
    ];
    movies.forEach((movie) => {
      if (hasMediaInList([...existingTitles, ...suggestions], movie)) return;
      suggestions.push({
        id: `suggestion-${movie.source}-${movie.id}`,
        source: "new",
        type: "movie",
        title: movie.title,
        year: movie.year || movie.raw?.year || "",
        genres: movie.genres || ["Film"],
        cast: movie.cast || [],
        moods: movie.moods || [],
        externalRating: movie.externalRating || movie.raw?.rating || "",
        poster: movie.poster || "",
        description: movie.description || movie.raw?.description || "",
        reasons: movie.reasons || [`neuer Filmvorschlag aus ${seed}`],
        rawSuggestion: movie.raw || movie
      });
    });
  }

  for (const seed of seriesSeeds.length ? seriesSeeds : discoverySeedMap.mix) {
    const tmdbSeries = await searchTmdbDiscover(seed, "series").catch(() => []);
    tmdbSeries.forEach((show) => {
      if (hasMediaInList([...existingTitles, ...suggestions], show)) return;
      suggestions.push(show);
    });

    const seriesResponse = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(seed)}`).catch(() => null);
    if (seriesResponse?.ok) {
      const data = await seriesResponse.json();
      data.slice(0, 4).forEach(({ show }) => {
        const candidate = {
          type: "series",
          title: show.name,
          year: show.premiered ? show.premiered.slice(0, 4) : ""
        };
        if (hasMediaInList([...existingTitles, ...suggestions], candidate)) return;
        suggestions.push({
          id: `suggestion-tvmaze-${show.id}`,
          source: "new",
          type: "series",
          title: show.name,
          year: show.premiered ? show.premiered.slice(0, 4) : "",
          genres: show.genres || [],
          cast: [],
          moods: [],
          poster: show.image?.original || show.image?.medium || "",
          description: (show.summary || "").replace(/<[^>]+>/g, ""),
          externalId: show.id,
          reasons: [`Serienvorschlag aus ${seed}`]
        });
      });
    }
  }

  const unique = dedupeMedia(suggestions);
  state.newSuggestions = (await enrichSuggestionImages(unique)).slice(0, 20);
  state.swipeMode = "new";
  state.swipeIndex = 0;
  $$("#swipeMode button").forEach((button) => button.classList.toggle("active", button.dataset.swipeMode === "new"));
  renderSwipe();
}

function getLevel(minutes, levels) {
  const current = levels.find(([_, limit]) => minutes < limit) || levels[levels.length - 1];
  const previousLimit = levels[Math.max(0, levels.indexOf(current) - 1)]?.[1] || 0;
  const progress = Math.min(100, ((minutes - previousLimit) / (current[1] - previousLimit)) * 100);
  return { name: current[0], next: current[1], progress: Number.isFinite(progress) ? progress : 100 };
}

function getMovieLevel(minutes) {
  return getLevel(minutes, [
    ["Film-Starter", 360],
    ["Popcorn-Profi", 720],
    ["Couch-Cineast", 1500],
    ["Movie-Marathoner", 3000],
    ["Blockbuster-Jäger", 6000],
    ["Filmjunkie", 12000],
    ["Kino-Legende", 24000]
  ]);
}

function getSeriesLevel(minutes) {
  return getLevel(minutes, [
    ["Serien-Starter", 600],
    ["Folgen-Sammler", 1800],
    ["Staffel-Profi", 4500],
    ["Binge-Buddy", 9000],
    ["Serienjunkie", 18000],
    ["Showrunner", 36000],
    ["Serien-Legende", 72000]
  ]);
}

function filteredTitles() {
  const term = state.search.toLowerCase();
  return state.titles.filter((title) => {
    const kindMatch = state.kind === "all" || title.type === state.kind;
    const statusMatch = state.status === "all" || title.status === state.status;
    const haystack = [
      title.title,
      title.description,
      title.comment,
      ...(title.genres || []),
      ...(title.cast || []),
      ...(title.moods || [])
    ].join(" ").toLowerCase();
    return kindMatch && statusMatch && (!term || haystack.includes(term));
  });
}

function renderStatusChips() {
  $("#statusChips").innerHTML = [
    `<button class="chip ${state.status === "all" ? "active" : ""}" data-status="all">Alle Status</button>`,
    ...statuses.map((status) => `<button class="chip ${state.status === status ? "active" : ""}" data-status="${status}">${status}</button>`)
  ].join("");
}

function renderLibrary() {
  renderStatusChips();
  const titles = filteredTitles();
  $("#emptyState").style.display = titles.length ? "none" : "block";
  $("#titleGrid").innerHTML = titles.map((title) => {
    const watched = getWatchedEpisodes(title).length;
    const total = (title.episodes || []).length;
    const progress = title.type === "series" ? `<div class="meta">${watched}/${total} Episoden gesehen</div>` : "";
    const tags = [...(title.genres || []), ...(title.moods || [])].slice(0, 3);
    const titlePoster = safeImageUrl(title.poster);
    const poster = titlePoster
      ? `<div class="poster"><img src="${escapeHtml(titlePoster)}" alt="" referrerpolicy="no-referrer"></div>`
      : `<div class="poster poster-placeholder"><span>${title.type === "movie" ? "Film" : "Serie"}</span><strong>${escapeHtml(titleInitials(title.title))}</strong></div>`;
    return `
      <article class="title-card">
        ${poster}
        <div class="card-body">
          <h3>${escapeHtml(title.title)}</h3>
          <div class="meta">${title.year || "ohne Jahr"} · <span class="status ${statusClass(title.status)}">${title.status}</span></div>
          ${progress}
          <div class="rating-line">
            <span>Dein Rating</span>
            <span class="own-rating">${title.rating ?? "-"}/10</span>
          </div>
          ${title.externalRating ? `<div class="meta">${escapeHtml(title.externalRating)}</div>` : ""}
          <div class="card-tags">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
          <div class="card-actions">
            <button class="secondary" data-edit="${title.id}">Bearbeiten</button>
            ${title.type === "series" ? `<button class="secondary" data-next="${title.id}">Nächste Folge</button>` : `<button class="secondary" data-done="${title.id}">Gesehen</button>`}
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderStats() {
  const movieMinutes = getMovieMinutes();
  const seriesMinutes = getSeriesMinutes();
  const minutes = movieMinutes + seriesMinutes;
  const watchedMovies = state.titles.filter((title) => title.type === "movie" && (title.status === "Abgeschlossen" || title.status === "Rewatch" || title.watchedAt)).length;
  const watchedEpisodes = state.titles.reduce((sum, title) => sum + getWatchedEpisodes(title).length, 0);
  const ratings = state.titles.map((title) => title.rating).filter((rating) => rating !== null && rating !== undefined);
  const average = ratings.length ? (ratings.reduce((sum, rating) => sum + Number(rating), 0) / ratings.length).toFixed(1) : "-";
  const movieLevel = getMovieLevel(movieMinutes);
  const seriesLevel = getSeriesLevel(seriesMinutes);
  const events = getWatchEvents();

  $("#statMinutes").textContent = minutes.toLocaleString("de-DE");
  $("#statMovies").textContent = watchedMovies;
  $("#statEpisodes").textContent = watchedEpisodes;
  $("#statAverage").textContent = average;
  $("#movieWatchLevel").textContent = movieLevel.name;
  $("#movieLevelMeter").style.width = `${movieLevel.progress}%`;
  $("#movieLevelHint").textContent = `${movieMinutes.toLocaleString("de-DE")} Film-Minuten`;
  $("#seriesWatchLevel").textContent = seriesLevel.name;
  $("#seriesLevelMeter").style.width = `${seriesLevel.progress}%`;
  $("#seriesLevelHint").textContent = `${seriesMinutes.toLocaleString("de-DE")} Serien-Minuten`;

  const top = [...state.titles]
    .filter((title) => title.rating !== null && title.rating !== undefined)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 8);
  $("#topRated").innerHTML = top.length ? top.map((title) => listItem(title.title, `${title.rating}/10`)).join("") : emptyLine("Noch keine Bewertungen");

  const tagCounts = {};
  state.titles.forEach((title) => [...(title.genres || []), ...(title.moods || [])].forEach((tag) => {
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }));
  const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 18);
  $("#tagStats").innerHTML = tags.length ? tags.map(([tag, count]) => `<span class="tag">${escapeHtml(tag)} · ${count}</span>`).join("") : emptyLine("Noch keine Tags");

  const topEpisodes = state.titles
    .flatMap((title) => (title.episodes || []).map((episode) => ({ title, episode })))
    .filter(({ episode }) => episode.rating !== null && episode.rating !== undefined)
    .sort((a, b) => Number(b.episode.rating) - Number(a.episode.rating))
    .slice(0, 8);
  $("#topEpisodes").innerHTML = topEpisodes.length
    ? topEpisodes.map(({ title, episode }) => listItem(`${title.title} · S${episode.season || 1} E${episode.number || "?"}`, `${episode.rating}/10`)).join("")
    : emptyLine("Noch keine Episodenbewertungen");

  const monthCounts = {};
  events.forEach((event) => {
    const label = monthLabel(event.date);
    monthCounts[label] = (monthCounts[label] || 0) + Number(event.minutes || 0);
  });
  const months = Object.entries(monthCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  $("#monthlyStats").innerHTML = months.length
    ? months.map(([month, monthMinutes]) => listItem(month, `${Math.round(monthMinutes / 60)} Std.`)).join("")
    : emptyLine("Noch keine Watch-Daten");

  $("#watchHistory").innerHTML = events.length
    ? events.slice(0, 10).map((event) => listItem(`${event.label} · ${event.detail}`, event.date ? new Date(event.date).toLocaleDateString("de-DE") : "ohne Datum")).join("")
    : emptyLine("Noch kein Verlauf");

  const topGenre = tags[0]?.[0] || "noch offen";
  const strongestMonth = months[0]?.[0] || "noch offen";
  const bestEpisode = topEpisodes[0] ? `${topEpisodes[0].title.title} S${topEpisodes[0].episode.season || 1} E${topEpisodes[0].episode.number || "?"}` : "noch offen";
  $("#wrappedText").innerHTML = `
    <p>Du hast bisher <strong>${Math.round(minutes / 60).toLocaleString("de-DE")} Stunden</strong> gesammelt.</p>
    <p>Film-Level: <strong>${escapeHtml(movieLevel.name)}</strong> mit <strong>${Math.round(movieMinutes / 60).toLocaleString("de-DE")} Film-Stunden</strong>.</p>
    <p>Serien-Level: <strong>${escapeHtml(seriesLevel.name)}</strong> mit <strong>${Math.round(seriesMinutes / 60).toLocaleString("de-DE")} Serien-Stunden</strong>.</p>
    <p>Dein stärkstes Genre oder Mood ist gerade <strong>${escapeHtml(topGenre)}</strong>.</p>
    <p>Dein stärkster Monat ist <strong>${escapeHtml(strongestMonth)}</strong>.</p>
    <p>Deine beste Episode ist aktuell <strong>${escapeHtml(bestEpisode)}</strong>.</p>
  `;
}

function renderCalendar() {
  const cursor = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth(), 1);
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const gridStart = addDays(monthStart, -((monthStart.getDay() + 6) % 7));
  const events = getCalendarEvents();
  const eventMap = events.reduce((map, event) => {
    map[event.date] ||= [];
    map[event.date].push(event);
    return map;
  }, {});

  $("#calendarMonthTitle").textContent = cursor.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  $("#calendarMonthHint").textContent = "Release-Termine aus Serienepisoden und deine geplanten Watch-Termine.";

  const today = todayIso();
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  $("#calendarGrid").innerHTML = days.map((day) => {
    const iso = toIsoDate(day);
    const dayEvents = eventMap[iso] || [];
    const outside = day.getMonth() !== cursor.getMonth();
    return `
      <button type="button" class="calendar-day ${outside ? "outside" : ""} ${iso === today ? "today" : ""}" data-calendar-date="${iso}">
        <span>${day.getDate()}</span>
        <div>
          ${dayEvents.slice(0, 3).map((event) => `<small class="${event.kind}">${escapeHtml(event.short)}</small>`).join("")}
          ${dayEvents.length > 3 ? `<small>+${dayEvents.length - 3} mehr</small>` : ""}
        </div>
      </button>
    `;
  }).join("");

  const weekEnd = toIsoDate(addDays(parseIsoDate(today), 7));
  const upcoming = events
    .filter((event) => event.date >= today && event.date <= weekEnd)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 10);
  $("#calendarList").innerHTML = upcoming.length
    ? upcoming.map((event) => listItem(event.label, `${new Date(`${event.date}T00:00:00`).toLocaleDateString("de-DE")} · ${event.typeLabel}`)).join("")
    : emptyLine("Diese Woche ist noch nichts geplant.");

  renderPlanControls();
  renderCalendarSelection();
  renderNotificationStatus();
  maybeSendCalendarNotifications(upcoming);
}

function isTitleCalendarIncluded(title) {
  return Boolean(title.includeInCalendar || title.plannedAt || title.releaseDate || (title.episodes || []).some((episode) => episode.plannedAt));
}

function getCalendarEvents() {
  const events = [];
  state.titles.filter(isTitleCalendarIncluded).forEach((title) => {
    if (title.type === "movie" && title.plannedAt) {
      events.push({
        id: `${title.id}:movie-plan`,
        date: title.plannedAt,
        kind: "planned",
        short: "Film geplant",
        label: title.title,
        typeLabel: "geplant"
      });
    }

    if (title.type === "movie" && title.releaseDate) {
      events.push({
        id: `${title.id}:movie-release`,
        date: title.releaseDate,
        kind: "release",
        short: "Filmstart",
        label: title.title,
        typeLabel: "Release"
      });
    }

    (title.episodes || []).forEach((episode) => {
      const episodeLabel = `${title.title} · S${episode.season || 1} E${episode.number || "?"}`;
      if (episode.airdate) {
        events.push({
          id: `${title.id}:${episode.id || episode.number}:release`,
          date: episode.airdate,
          kind: "release",
          short: `E${episode.number || "?"} Release`,
          label: `${episodeLabel} · ${episode.name || "Episode"}`,
          typeLabel: "erscheint"
        });
      }
      if (episode.plannedAt) {
        events.push({
          id: `${title.id}:${episode.id || episode.number}:planned`,
          date: episode.plannedAt,
          kind: "planned",
          short: `E${episode.number || "?"} geplant`,
          label: `${episodeLabel} · ${episode.name || "Episode"}`,
          typeLabel: "geplant"
        });
      }
    });
  });

  return events
    .filter((event) => parseIsoDate(event.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function renderPlanControls() {
  const titleSelect = $("#planTitleSelect");
  const episodeSelect = $("#planEpisodeSelect");
  const dateInput = $("#planDateInput");
  if (!titleSelect || !episodeSelect || !dateInput) return;

  const selectedTitleId = titleSelect.value;
  titleSelect.innerHTML = state.titles.length
    ? state.titles.map((title) => `<option value="${title.id}">${escapeHtml(title.title)} · ${title.type === "movie" ? "Film" : "Serie"}</option>`).join("")
    : `<option value="">Noch keine Titel</option>`;
  if (selectedTitleId && state.titles.some((title) => title.id === selectedTitleId)) {
    titleSelect.value = selectedTitleId;
  } else if (state.titles[0]) {
    titleSelect.value = state.titles[0].id;
  }

  const selectedTitle = state.titles.find((title) => title.id === titleSelect.value);
  if (!selectedTitle) {
    episodeSelect.innerHTML = `<option value="">-</option>`;
    dateInput.value = "";
    return;
  }

  if (selectedTitle.type === "movie") {
    episodeSelect.innerHTML = `<option value="movie">Film schauen</option>`;
    dateInput.value ||= selectedTitle.plannedAt || todayIso();
    return;
  }

  const episodes = normalizeEpisodesForEditor(selectedTitle.episodes || []);
  const openEpisodes = episodes.filter((episode) => !episode.seen);
  const selectedEpisodeId = episodeSelect.value;
  episodeSelect.innerHTML = openEpisodes.length
    ? openEpisodes.map((episode) => `<option value="${episode.id || `${episode.season}-${episode.number}`}">S${episode.season} E${episode.number} · ${escapeHtml(episode.name || "Episode")}</option>`).join("")
    : `<option value="">Keine offenen Folgen</option>`;
  if (selectedEpisodeId && openEpisodes.some((episode) => String(episode.id || `${episode.season}-${episode.number}`) === selectedEpisodeId)) {
    episodeSelect.value = selectedEpisodeId;
  }
  const selectedEpisode = openEpisodes.find((episode) => String(episode.id || `${episode.season}-${episode.number}`) === episodeSelect.value);
  dateInput.value ||= selectedEpisode?.plannedAt || todayIso();
}

function renderCalendarSelection() {
  const addSelect = $("#calendarAddSelect");
  const list = $("#calendarIncludedList");
  if (!addSelect || !list) return;
  const available = state.titles.filter((title) => !isTitleCalendarIncluded(title));
  const included = state.titles.filter(isTitleCalendarIncluded);
  addSelect.innerHTML = available.length
    ? available.map((title) => `<option value="${title.id}">${escapeHtml(title.title)} · ${title.type === "movie" ? "Film" : "Serie"}</option>`).join("")
    : `<option value="">Alles ist schon im Kalender</option>`;
  $("#addToCalendarBtn").disabled = !available.length;
  list.innerHTML = included.length
    ? included.map((title) => `
      <div class="calendar-picked">
        <div>
          <strong>${escapeHtml(title.title)}</strong>
          <span>${title.type === "movie" ? "Film" : "Serie"} · ${escapeHtml(title.year || "ohne Jahr")}</span>
        </div>
        <button class="danger" type="button" data-calendar-remove="${title.id}">Entfernen</button>
      </div>
    `).join("")
    : emptyLine("Noch keine Titel im Kalender.");
}

async function addTitleToCalendar() {
  const title = state.titles.find((item) => item.id === $("#calendarAddSelect").value);
  if (!title) return;
  title.includeInCalendar = true;
  title.updatedAt = Date.now();
  await saveTitle(sanitizeTitle(title));
  await refresh();
}

async function removeTitleFromCalendar(id) {
  const title = state.titles.find((item) => item.id === id);
  if (!title) return;
  title.includeInCalendar = false;
  title.plannedAt = "";
  title.releaseDate = "";
  (title.episodes || []).forEach((episode) => {
    episode.plannedAt = "";
  });
  title.updatedAt = Date.now();
  await saveTitle(sanitizeTitle(title));
  await refresh();
}

async function savePlannedWatch() {
  const title = state.titles.find((item) => item.id === $("#planTitleSelect").value);
  const date = $("#planDateInput").value;
  if (!title || !parseIsoDate(date)) {
    alert("Bitte Titel und Datum auswählen.");
    return;
  }

  if (title.type === "movie") {
    title.plannedAt = date;
  } else {
    const episodeId = $("#planEpisodeSelect").value;
    const episode = (title.episodes || []).find((item) => String(item.id || `${item.season}-${item.number}`) === episodeId);
    if (!episode) {
      alert("Bitte eine offene Folge auswählen.");
      return;
    }
    episode.plannedAt = date;
  }
  title.includeInCalendar = true;
  title.updatedAt = Date.now();
  await saveTitle(sanitizeTitle(title));
  await refresh();
}

async function clearPlannedWatch() {
  const title = state.titles.find((item) => item.id === $("#planTitleSelect").value);
  if (!title) return;
  if (title.type === "movie") {
    title.plannedAt = "";
  } else {
    const episodeId = $("#planEpisodeSelect").value;
    const episode = (title.episodes || []).find((item) => String(item.id || `${item.season}-${item.number}`) === episodeId);
    if (episode) episode.plannedAt = "";
  }
  title.updatedAt = Date.now();
  await saveTitle(sanitizeTitle(title));
  await refresh();
}

async function fetchTvmazeShowWithEpisodes(title) {
  if (title.externalId) {
    const response = await fetch(`https://api.tvmaze.com/shows/${encodeURIComponent(title.externalId)}?embed=episodes`);
    if (response.ok) {
      const data = await response.json();
      const expectedYear = mediaYear(title);
      const actualYear = data.premiered ? data.premiered.slice(0, 4) : "";
      if (!expectedYear || !actualYear || expectedYear === actualYear) return data;
    }
  }
  const searchResponse = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title.title)}`);
  if (!searchResponse.ok) return null;
  const expectedKey = normalizeTitleKey(title.title);
  const expectedYear = mediaYear(title);
  const searchResults = await searchResponse.json();
  const candidates = searchResults
    .map(({ show }) => show)
    .filter((show) => normalizeTitleKey(show.name) === expectedKey || normalizeTitleKey(show.name).includes(expectedKey) || expectedKey.includes(normalizeTitleKey(show.name)))
    .slice(0, 4);
  if (!candidates.length) return null;

  const detailed = [];
  for (const show of candidates) {
    const response = await fetch(`https://api.tvmaze.com/shows/${show.id}?embed=episodes`);
    if (!response.ok) continue;
    detailed.push(await response.json());
  }
  if (!detailed.length) return null;

  const yearMatch = expectedYear
    ? detailed.find((show) => show.premiered?.slice(0, 4) === expectedYear)
    : null;
  if (yearMatch) return yearMatch;

  return detailed.sort((a, b) => (b._embedded?.episodes?.length || 0) - (a._embedded?.episodes?.length || 0))[0];
}

function mergeEpisodes(existingEpisodes = [], remoteEpisodes = [], fallbackRuntime = 45, options = {}) {
  const existing = normalizeEpisodesForEditor(existingEpisodes);
  const byKey = new Map(existing.map((episode) => [`${episode.season}-${episode.number}`, episode]));
  const merged = remoteEpisodes.map((episode) => {
    const key = `${episode.season}-${episode.number}`;
    const current = byKey.get(key) || {};
    const remoteName = options.useGenericRemoteNames ? `Episode ${episode.number}` : episode.name;
    const currentNameLooksTvmaze = String(current.id || "").startsWith("tvmaze-") && options.useGenericRemoteNames;
    return {
      ...current,
      id: current.id || `tvmaze-${episode.id}`,
      season: episode.season,
      number: episode.number,
      name: currentNameLooksTvmaze ? `Episode ${episode.number}` : (current.name || remoteName || `Episode ${episode.number}`),
      runtime: current.runtime || episode.runtime || episode.averageRuntime || fallbackRuntime,
      airdate: episode.airdate || current.airdate || "",
      seen: Boolean(current.seen),
      rating: current.rating ?? null,
      watchedAt: current.watchedAt || "",
      plannedAt: current.plannedAt || "",
      comment: current.comment || ""
    };
  });
  existing.forEach((episode) => {
    const key = `${episode.season}-${episode.number}`;
    if (!merged.some((item) => `${item.season}-${item.number}` === key)) merged.push(episode);
  });
  return normalizeEpisodesForEditor(merged).sort((a, b) => a.season - b.season || a.number - b.number);
}

async function refreshReleaseDates() {
  const series = state.titles.filter((title) => title.type === "series");
  if (!series.length) {
    alert("Keine Serien zum Aktualisieren vorhanden.");
    return;
  }
  $("#notifyStatus").textContent = "Release-Daten werden aktualisiert...";
  let updated = 0;
  let releaseCount = 0;
  let nextReleaseDate = "";
  for (const title of series) {
    try {
      const data = await fetchTvmazeShowWithEpisodes(title);
      const remoteEpisodes = data?._embedded?.episodes || [];
      if (!remoteEpisodes.length) continue;
      const anime = isAnimeTitle(title);
      title.externalId = String(data.id || title.externalId || "");
      title.source = anime ? (title.source || "anime") : "tvmaze";
      title.includeInCalendar = true;
      title.episodes = mergeEpisodes(title.episodes || [], remoteEpisodes, data.averageRuntime || title.runtime || 45, {
        useGenericRemoteNames: anime
      });
      const titleReleaseDates = title.episodes
        .map((episode) => episode.airdate)
        .filter((date) => parseIsoDate(date));
      releaseCount += titleReleaseDates.length;
      const upcomingRelease = titleReleaseDates
        .filter((date) => date >= todayIso())
        .sort((a, b) => a.localeCompare(b))[0];
      if (upcomingRelease && (!nextReleaseDate || upcomingRelease < nextReleaseDate)) {
        nextReleaseDate = upcomingRelease;
      }
      title.updatedAt = Date.now();
      await saveTitle(sanitizeTitle(title));
      updated += 1;
    } catch {
      continue;
    }
  }
  await refresh();
  if (nextReleaseDate) {
    state.calendarDate = parseIsoDate(nextReleaseDate);
    renderCalendar();
  }
  $("#notifyStatus").textContent = updated
    ? `${updated} Serien aktualisiert, ${releaseCount} Release-Termine gefunden${nextReleaseDate ? `, nächster Termin: ${new Date(`${nextReleaseDate}T00:00:00`).toLocaleDateString("de-DE")}` : ", aber keine zukünftigen Termine"}.`
    : "Keine neuen Release-Daten gefunden.";
}

function renderNotificationStatus() {
  const status = $("#notifyStatus");
  const button = $("#enableNotifyBtn");
  if (!status || !button) return;
  if (!("Notification" in window)) {
    status.textContent = "Browser-Benachrichtigungen werden hier nicht unterstützt.";
    button.disabled = true;
    return;
  }
  status.textContent = Notification.permission === "granted"
    ? "Browser-Benachrichtigungen sind aktiv, solange die App geöffnet ist."
    : "In-App-Hinweise sind aktiv. Browser-Benachrichtigungen sind optional.";
}

function maybeSendCalendarNotifications(upcoming) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const todaysEvents = upcoming.filter((event) => event.date === todayIso());
  const notifyKey = `watch-up-notified-${todayIso()}`;
  let sent = [];
  try {
    sent = JSON.parse(localStorage.getItem(notifyKey) || "[]");
  } catch {
    sent = [];
  }
  const nextSent = [...sent];
  todaysEvents.forEach((event) => {
    if (sent.includes(event.id)) return;
    new Notification("Watch Up", { body: `${event.typeLabel}: ${event.label}` });
    nextSent.push(event.id);
  });
  localStorage.setItem(notifyKey, JSON.stringify(nextSent));
}

function listItem(left, right) {
  return `<div class="list-item"><span>${escapeHtml(left)}</span><strong>${escapeHtml(String(right))}</strong></div>`;
}

function emptyLine(text) {
  return `<p class="muted">${text}</p>`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function stripHtml(value = "") {
  const template = document.createElement("template");
  template.innerHTML = String(value);
  return template.content.textContent || "";
}

function safeText(value = "", maxLength = 5000) {
  return stripHtml(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeImageUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:image/")) return raw;
  try {
    const url = new URL(raw, window.location.href);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    return "";
  }
  return "";
}

function getTmdbKey() {
  return localStorage.getItem(TMDB_KEY) || "";
}

function setTmdbStatus() {
  const input = $("#tmdbKeyInput");
  const status = $("#tmdbKeyStatus");
  if (!input || !status) return;
  const hasKey = Boolean(getTmdbKey());
  input.value = hasKey ? "••••••••••••••••" : "";
  status.textContent = hasKey
    ? "TMDb ist aktiv. Neue Suchen nutzen bessere Poster."
    : "Kein TMDb-Key gespeichert.";
}

async function tmdbFetch(path, params = {}) {
  const key = getTmdbKey();
  if (!key) return null;
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  Object.entries({
    language: "de-DE",
    include_adult: "false",
    ...params
  }).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, value);
  });

  const options = key.startsWith("eyJ")
    ? { headers: { Authorization: `Bearer ${key}` } }
    : {};
  if (!key.startsWith("eyJ")) url.searchParams.set("api_key", key);

  try {
    const response = await fetch(url, options);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

function tmdbPoster(path) {
  return path ? `${TMDB_IMAGE_BASE}${path}` : "";
}

function tmdbToSuggestion(item) {
  const type = item.media_type === "tv" ? "series" : "movie";
  const title = type === "series" ? item.name : item.title;
  const yearSource = type === "series" ? item.first_air_date : item.release_date;
  return {
    source: "tmdb",
    id: String(item.id),
    title: title || "",
    image: tmdbPoster(item.poster_path),
    poster: tmdbPoster(item.poster_path),
    detail: `${type === "series" ? "Serie" : "Film"} · ${yearSource ? yearSource.slice(0, 4) : "ohne Jahr"} · TMDb`,
    raw: {
      tmdbId: item.id,
      type,
      title: title || "",
      year: yearSource ? yearSource.slice(0, 4) : "",
      description: item.overview || "",
      poster: tmdbPoster(item.poster_path),
      rating: item.vote_average ? `TMDb ${Number(item.vote_average).toFixed(1)}/10` : "",
      popularity: item.popularity || 0
    }
  };
}

async function searchTmdbTitles(query, limit = 12) {
  const data = await tmdbFetch("/search/multi", { query, page: 1 });
  if (!data?.results) return [];
  return data.results
    .filter((item) => item.media_type === "movie" || item.media_type === "tv")
    .map(tmdbToSuggestion)
    .filter((item) => item.title)
    .sort((a, b) => (b.raw.popularity || 0) - (a.raw.popularity || 0))
    .slice(0, limit);
}

async function searchTmdbDiscover(seed, type = "movie") {
  const query = seed.replace("science fiction", "sci-fi");
  const results = await searchTmdbTitles(query, 10);
  return results
    .filter((item) => item.raw.type === type)
    .map((item) => ({
      id: `suggestion-tmdb-${item.raw.type}-${item.id}`,
      source: "new",
      type: item.raw.type,
      title: item.title,
      year: item.raw.year,
      genres: [type === "movie" ? "Film" : "Serie"],
      cast: [],
      moods: [],
      poster: item.poster,
      description: item.raw.description,
      externalRating: item.raw.rating,
      reasons: [`TMDb-Vorschlag aus ${seed}`],
      rawSuggestion: item.raw
    }));
}

function titleSearchVariants(query) {
  const normalized = query.trim().replace(/\s+/g, " ");
  const variants = new Set([normalized]);
  if (normalized.toLowerCase().includes("one piece") && /\bz\b/i.test(normalized)) {
    variants.add("One Piece Film: Z");
    variants.add("One Piece Film Z");
  }
  variants.add(`${normalized} film`);
  variants.add(`${normalized} movie`);
  variants.add(`${normalized} anime`);
  return [...variants].filter(Boolean);
}

function resetForm() {
  $("#titleForm").reset();
  $("#editId").value = "";
  formEpisodes = [];
  selectedSeason = null;
  $("#episodeEditor").innerHTML = "";
  $("#seriesSuggestions").innerHTML = "";
  $("#titleSuggestions").innerHTML = "";
  $("#titleSearchNote").textContent = "Tippe einen Titel ein.";
  $("#deleteBtn").style.visibility = "hidden";
  $("#dialogHeading").textContent = "Titel hinzufügen";
  $("#importNote").textContent = "";
  $("#titleForm").dataset.tvmazeId = "";
  updateSeriesVisibility();
}

function openDialog(title = null) {
  resetForm();
  if (title) {
    $("#dialogHeading").textContent = "Titel bearbeiten";
    $("#editId").value = title.id;
    $("#titleInput").value = title.title || "";
    $("#typeInput").value = title.type || "movie";
    $("#statusInput").value = title.status || statuses[0];
    $("#yearInput").value = title.year || "";
    $("#runtimeInput").value = title.runtime || "";
    $("#ratingInput").value = title.rating ?? "";
    $("#watchedAtInput").value = title.watchedAt || "";
    $("#rewatchCountInput").value = title.rewatchCount || 0;
    $("#genresInput").value = formatTags(title.genres);
    $("#castInput").value = formatTags(title.cast);
    $("#moodsInput").value = formatTags(title.moods);
    $("#externalRatingInput").value = title.externalRating || "";
    $("#posterInput").value = title.poster || "";
    $("#descriptionInput").value = title.description || "";
    $("#commentInput").value = title.comment || "";
    $("#deleteBtn").style.visibility = "visible";
    $("#titleForm").dataset.tvmazeId = title.externalId || "";
    updateSeriesVisibility();
    renderEpisodeEditor(title.episodes || []);
    if (title.type === "series" && (title.episodes || []).some((episode, index) => isMissingEpisodeName(episode.name, episode.number || index + 1))) {
      $("#importNote").textContent = "Einige Episodennamen fehlen. Du kannst sie ergänzen lassen.";
    }
  }
  $("#titleDialog").showModal();
}

function updateSeriesVisibility() {
  $("#seriesBox").classList.toggle("active", $("#typeInput").value === "series");
}

function setEpisodeLoading(isLoading, text = "Lädt...") {
  const loader = $("#episodeLoader");
  const loaderText = $("#episodeLoaderText");
  const enrichButton = $("#enrichEpisodesBtn");
  const importButton = $("#importSeriesBtn");
  if (!loader || !loaderText) return;
  loader.hidden = !isLoading;
  loaderText.textContent = text;
  if (enrichButton) enrichButton.disabled = isLoading;
  if (importButton) importButton.disabled = isLoading;
}

function normalizeEpisodesForEditor(episodes = []) {
  return episodes.map((episode, index) => {
    const season = Number.isFinite(Number(episode.season)) ? Number(episode.season) : 1;
    const number = Number.isFinite(Number(episode.number)) ? Number(episode.number) : index + 1;
    return {
      ...episode,
      season,
      number,
      name: episode.name || `Episode ${number}`,
      seen: Boolean(episode.seen),
      rating: episode.rating ?? null,
      watchedAt: episode.watchedAt || "",
      comment: episode.comment || ""
    };
  });
}

function isMissingEpisodeName(name, number) {
  if (!name) return true;
  const normalized = String(name).trim().toLowerCase();
  return normalized === "episode" || normalized === `episode ${number}` || normalized === "undefined";
}

async function fetchTvmazeEpisodesByTitle(title) {
  const response = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}&embed=episodes`);
  if (!response.ok) return [];
  const data = await response.json();
  return (data._embedded?.episodes || []).map((episode) => ({
    season: episode.season,
    number: episode.number,
    name: episode.name,
    runtime: episode.runtime || episode.averageRuntime || data.averageRuntime || 45,
    airdate: episode.airdate || ""
  }));
}

async function fetchJikanEpisodeNames(title, expectedCount) {
  try {
    const searchResponse = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&type=tv&limit=1`);
    if (!searchResponse.ok) return [];
    const searchData = await searchResponse.json();
    const animeId = searchData.data?.[0]?.mal_id;
    if (!animeId) return [];

    const firstResponse = await fetch(`https://api.jikan.moe/v4/anime/${animeId}/episodes?page=1`);
    if (!firstResponse.ok) return [];
    const firstData = await firstResponse.json();
    const lastPage = firstData.pagination?.last_visible_page || 1;
    const neededPages = Math.ceil(Math.max(expectedCount || 25, 25) / 25);
    const pageLimit = Math.min(lastPage, neededPages, 20);
    const allEpisodes = [...(firstData.data || [])];

    for (let page = 2; page <= pageLimit; page += 1) {
      const response = await fetch(`https://api.jikan.moe/v4/anime/${animeId}/episodes?page=${page}`);
      if (!response.ok) break;
      const data = await response.json();
      allEpisodes.push(...(data.data || []));
    }

    return allEpisodes.map((episode) => ({
      number: episode.mal_id,
      name: episode.title || episode.title_romanji || episode.title_japanese || ""
    }));
  } catch {
    return [];
  }
}

async function fetchKitsuEpisodeNames(title, expectedCount, startNumber = 1) {
  try {
    const searchResponse = await fetch(`https://kitsu.io/api/edge/anime?filter%5Btext%5D=${encodeURIComponent(title)}&page%5Blimit%5D=5`);
    if (!searchResponse.ok) return [];
    const searchData = await searchResponse.json();
    const normalizedTitle = title.trim().toLowerCase();
    const anime = (searchData.data || []).find((item) => {
      const attributes = item.attributes || {};
      const candidates = [
        attributes.canonicalTitle,
        attributes.titles?.en,
        attributes.titles?.en_jp,
        attributes.titles?.ja_jp
      ].filter(Boolean).map((value) => value.toLowerCase());
      return attributes.subtype === "TV" && candidates.some((candidate) => candidate === normalizedTitle);
    }) || (searchData.data || []).find((item) => item.attributes?.subtype === "TV");

    if (!anime?.id) return [];

    const pageSize = 20;
    const batchSize = 200;
    const startOffset = Math.max(0, Math.floor((startNumber - 1) / pageSize) * pageSize);
    const maxOffset = startOffset + batchSize;
    const episodes = [];

    for (let offset = startOffset; offset < maxOffset; offset += pageSize) {
      const response = await fetch(`https://kitsu.io/api/edge/anime/${anime.id}/episodes?page%5Blimit%5D=${pageSize}&page%5Boffset%5D=${offset}`);
      if (!response.ok) break;
      const data = await response.json();
      const pageEpisodes = data.data || [];
      if (!pageEpisodes.length) break;
      episodes.push(...pageEpisodes.map((episode) => {
        const attributes = episode.attributes || {};
        return {
          number: Number(attributes.number),
          name: attributes.titles?.en_us || attributes.canonicalTitle || attributes.titles?.en_jp || attributes.titles?.ja_jp || ""
        };
      }));
      if (!data.links?.next) break;
    }

    return episodes.filter((episode) => Number.isFinite(episode.number) && episode.name);
  } catch {
    return [];
  }
}

async function enrichEpisodeNames(title, episodes) {
  const normalized = normalizeEpisodesForEditor(episodes);
  const hasMissingNames = normalized.some((episode) => isMissingEpisodeName(episode.name, episode.number));
  if (!hasMissingNames) return normalized;
  const firstMissingNumber = normalized.find((episode) => isMissingEpisodeName(episode.name, episode.number))?.number || 1;
  const anime = isAnimeTitle({
    title,
    genres: splitTags($("#genresInput")?.value || "")
  });

  const [tvmazeEpisodes, kitsuEpisodes, jikanEpisodes] = await Promise.all([
    fetchTvmazeEpisodesByTitle(title).catch(() => []),
    fetchKitsuEpisodeNames(title, normalized.length, firstMissingNumber).catch(() => []),
    fetchJikanEpisodeNames(title, normalized.length).catch(() => [])
  ]);
  const useTvmaze = tvmazeEpisodes.length && tvmazeEpisodes.length >= Math.min(normalized.length, 25);

  return normalized.map((episode, index) => {
    if (!isMissingEpisodeName(episode.name, episode.number)) return episode;
    const tvmazeMatch = useTvmaze
      ? tvmazeEpisodes.find((candidate) => candidate.season === episode.season && candidate.number === episode.number)
      : null;
    const kitsuMatch = kitsuEpisodes.find((candidate) => candidate.number === episode.number);
    const jikanMatch = jikanEpisodes.find((candidate) => candidate.number === episode.number);
    const fallbackName = anime
      ? kitsuMatch?.name || jikanMatch?.name || tvmazeMatch?.name || `Episode ${episode.number || index + 1}`
      : tvmazeMatch?.name || kitsuMatch?.name || jikanMatch?.name || `Episode ${episode.number || index + 1}`;
    return {
      ...episode,
      name: fallbackName,
      runtime: episode.runtime || tvmazeMatch?.runtime || 45,
      airdate: episode.airdate || tvmazeMatch?.airdate || ""
    };
  });
}

function renderEpisodeEditor(episodes = []) {
  if (episodes !== formEpisodes) {
    formEpisodes = normalizeEpisodesForEditor(episodes);
    selectedSeason = formEpisodes[0]?.season ?? null;
  }

  if (!formEpisodes.length) {
    $("#episodeEditor").innerHTML = `<p class="muted">Noch keine Episoden importiert.</p>`;
    return;
  }

  if (!formEpisodes.some((episode) => episode.season === selectedSeason)) {
    selectedSeason = formEpisodes[0].season;
  }

  const seasons = [...new Set(formEpisodes.map((episode) => episode.season))].sort((a, b) => a - b);
  const seasonCards = seasons.map((season) => {
    const seasonEpisodes = formEpisodes.filter((episode) => episode.season === season);
    const seen = seasonEpisodes.filter((episode) => episode.seen).length;
    const ratings = seasonEpisodes.map((episode) => episode.rating).filter((rating) => rating !== null && rating !== undefined);
    const average = ratings.length ? (ratings.reduce((sum, rating) => sum + Number(rating), 0) / ratings.length).toFixed(1) : "-";
    return `
      <button type="button" class="season-card ${season === selectedSeason ? "active" : ""}" data-season="${season}">
        <strong>Staffel ${season}</strong>
        <span>${seen}/${seasonEpisodes.length} gesehen</span>
        <small>Ø ${average}/10</small>
      </button>
    `;
  }).join("");

  const rows = formEpisodes
    .map((episode, index) => ({ episode, index }))
    .filter(({ episode }) => episode.season === selectedSeason)
    .map(({ episode, index }) => `
      <div class="episode-row" data-index="${index}">
        <button type="button" class="seen-toggle ${episode.seen ? "seen" : ""}">${episode.seen ? "Gesehen" : "Offen"}</button>
        <span class="episode-label">E${episode.number} · ${escapeHtml(episode.name || "Episode")}</span>
        <input class="episode-rating" type="number" min="0" max="10" step="0.5" placeholder="Rating" aria-label="Episoden-Rating von 0 bis 10" value="${episode.rating ?? ""}">
        <input class="episode-date" type="date" aria-label="Gesehen am" value="${episode.watchedAt || ""}">
        <input class="episode-note" placeholder="Kommentar" aria-label="Kommentar zur Episode" value="${escapeHtml(episode.comment || "")}">
      </div>
    `).join("");

  $("#episodeEditor").innerHTML = `
    <div class="season-grid">${seasonCards}</div>
    <div class="episode-header" aria-hidden="true">
      <span>Status</span>
      <span>Episode</span>
      <span>Rating</span>
      <span>Gesehen am</span>
      <span>Kommentar</span>
    </div>
    <div class="episode-list">${rows}</div>
  `;
}

function syncVisibleEpisodes() {
  $$("#episodeEditor .episode-row").forEach((row) => {
    const index = Number(row.dataset.index);
    formEpisodes[index] = {
      ...formEpisodes[index],
      seen: row.querySelector(".seen-toggle").classList.contains("seen"),
      rating: normalizeRating(row.querySelector(".episode-rating").value),
      watchedAt: row.querySelector(".episode-date").value,
      comment: row.querySelector(".episode-note").value.trim()
    };
  });
}

function collectEpisodes() {
  syncVisibleEpisodes();
  return normalizeEpisodesForEditor(formEpisodes);
}

function sanitizeEpisode(episode = {}, index = 0) {
  const number = Number.isFinite(Number(episode.number)) ? Number(episode.number) : index + 1;
  return {
    id: safeText(episode.id || crypto.randomUUID(), 120),
    season: Number.isFinite(Number(episode.season)) ? Number(episode.season) : 1,
    number,
    name: safeText(episode.name || `Episode ${number}`, 300),
    runtime: Number(episode.runtime) || null,
    airdate: safeText(episode.airdate || "", 30),
    plannedAt: safeText(episode.plannedAt || "", 30),
    seen: Boolean(episode.seen),
    rating: normalizeRating(episode.rating),
    watchedAt: safeText(episode.watchedAt || "", 30),
    comment: safeText(episode.comment || "", 1000)
  };
}

function sanitizeTitle(title = {}) {
  const type = title.type === "series" ? "series" : "movie";
  const status = statuses.includes(title.status) ? title.status : statuses[0];
  return {
    id: safeText(title.id || crypto.randomUUID(), 120),
    title: safeText(title.title || "", 300),
    type,
    status,
    year: safeText(title.year || "", 20),
    runtime: Number(title.runtime) || null,
    rating: normalizeRating(title.rating),
    watchedAt: safeText(title.watchedAt || "", 30),
    rewatchCount: Math.max(0, Number(title.rewatchCount || 0)),
    genres: (title.genres || []).map((tag) => safeText(tag, 80)).filter(Boolean).slice(0, 30),
    cast: (title.cast || []).map((person) => safeText(person, 120)).filter(Boolean).slice(0, 60),
    moods: (title.moods || []).map((mood) => safeText(mood, 80)).filter(Boolean).slice(0, 30),
    externalRating: safeText(title.externalRating || "", 120),
    externalId: safeText(title.externalId || "", 80),
    source: safeText(title.source || "", 60),
    includeInCalendar: Boolean(title.includeInCalendar),
    poster: safeImageUrl(title.poster),
    plannedAt: safeText(title.plannedAt || "", 30),
    releaseDate: safeText(title.releaseDate || "", 30),
    description: safeText(title.description || "", 5000),
    comment: safeText(title.comment || "", 3000),
    episodes: type === "series" ? (title.episodes || []).map(sanitizeEpisode).slice(0, 5000) : [],
    createdAt: Number(title.createdAt) || Date.now(),
    updatedAt: Number(title.updatedAt) || Date.now()
  };
}

function sanitizeSuggestion(suggestion = {}) {
  return {
    id: safeText(suggestion.id || crypto.randomUUID(), 160),
    source: safeText(suggestion.source || "new", 60),
    type: suggestion.type === "series" ? "series" : "movie",
    title: safeText(suggestion.title || "", 300),
    year: safeText(suggestion.year || "", 20),
    genres: (suggestion.genres || []).map((tag) => safeText(tag, 80)).filter(Boolean).slice(0, 30),
    cast: (suggestion.cast || []).map((person) => safeText(person, 120)).filter(Boolean).slice(0, 60),
    moods: (suggestion.moods || []).map((mood) => safeText(mood, 80)).filter(Boolean).slice(0, 30),
    externalRating: safeText(suggestion.externalRating || "", 120),
    poster: safeImageUrl(suggestion.poster),
    description: safeText(suggestion.description || "", 5000),
    reasons: (suggestion.reasons || []).map((reason) => safeText(reason, 160)).filter(Boolean).slice(0, 6),
    decision: safeText(suggestion.decision || "", 40),
    createdAt: Number(suggestion.createdAt) || Date.now(),
    updatedAt: Number(suggestion.updatedAt) || Date.now()
  };
}

function renderTitleSuggestions(results) {
  $("#titleSuggestions").innerHTML = results.map((item) => `
    <button type="button" class="suggestion" data-source="${item.source}" data-id="${item.id}">
      <span class="suggestion-poster">${safeImageUrl(item.image) ? `<img src="${escapeHtml(safeImageUrl(item.image))}" alt="" referrerpolicy="no-referrer">` : ""}</span>
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.detail)}</small>
      </span>
    </button>
  `).join("");
}

function commonsImageUrl(fileName, width = 600) {
  if (!fileName) return "";
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}?width=${width}`;
}

function claimValue(entity, property) {
  return entity?.claims?.[property]?.[0]?.mainsnak?.datavalue?.value || null;
}

async function enrichWikidataMovies(movies) {
  if (!movies.length) return movies;
  const ids = movies.map((movie) => movie.id).filter(Boolean).join("|");
  if (!ids) return movies;

  try {
    const response = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(ids)}&props=claims|descriptions&languages=de|en&format=json&origin=*`);
    if (!response.ok) return movies;
    const data = await response.json();
    return movies.map((movie) => {
      const entity = data.entities?.[movie.id];
      const imageName = claimValue(entity, "P18");
      const publicationDate = claimValue(entity, "P577")?.time || claimValue(entity, "P571")?.time || "";
      const year = publicationDate.match(/\b(19|20)\d{2}\b/)?.[0] || movie.raw.year || movie.year || "";
      const description = entity?.descriptions?.de?.value || entity?.descriptions?.en?.value || movie.raw.description || "";
      const image = commonsImageUrl(imageName);
      return {
        ...movie,
        image: image || movie.image || "",
        poster: image || movie.poster || "",
        detail: `Film · ${year || "ohne Jahr"} · ${description || movie.raw.description || ""}`,
        raw: {
          ...movie.raw,
          year,
          description,
          poster: image || movie.raw.poster || "",
          image: image || movie.raw.image || ""
        }
      };
    });
  } catch {
    return movies;
  }
}

async function fetchWikipediaDetails(title, type = "") {
  const deVariants = [
    title,
    type === "series" ? `${title} (Fernsehserie)` : "",
    type === "movie" ? `${title} (Film)` : ""
  ].filter(Boolean);
  const enVariants = [
    title,
    type === "series" ? `${title} (TV series)` : "",
    type === "movie" ? `${title} (film)` : ""
  ].filter(Boolean);

  let germanExtract = "";
  for (const [language, variants] of [["de", deVariants], ["en", enVariants]]) {
    for (const variant of variants) {
      try {
        const response = await fetch(`https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(variant)}`);
        if (!response.ok) continue;
        const data = await response.json();
        if (data.type === "disambiguation") continue;
        const image = data.originalimage?.source || data.thumbnail?.source || "";
        if (language === "de" && data.extract && !germanExtract) germanExtract = data.extract;
        if (image) return { extract: germanExtract, image };
      } catch {
        continue;
      }
    }
  }

  return { extract: germanExtract, image: "" };
}

async function searchWikidataMovies(query) {
  const searches = titleSearchVariants(query);
  const responses = await Promise.allSettled(searches.map((term) =>
    fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(term)}&language=de&format=json&limit=12&origin=*`)
  ));

  const seen = new Set();
  const movies = [];
  for (const resultResponse of responses) {
    if (resultResponse.status !== "fulfilled") continue;
    const response = resultResponse.value;
    if (!response.ok) continue;
    const data = await response.json();
    for (const result of data.search || []) {
      const description = result.description || "";
      const label = result.label || "";
      const lower = description.toLowerCase();
      const labelLower = label.toLowerCase();
      const looksLikeMovie = lower.includes("film") || lower.includes("movie");
      const unwanted = ["soundtrack", "dubbing", "album", "single", "song", "score", "character", "video game", "manga chapter", "episode"];
      if (!looksLikeMovie || unwanted.some((word) => lower.includes(word) || labelLower.includes(word)) || seen.has(result.id)) continue;
      seen.add(result.id);
      const year = description.match(/\b(19|20)\d{2}\b/)?.[0] || "ohne Jahr";
      movies.push({
        source: "wikidata",
        id: result.id,
        title: label,
        image: "",
        poster: "",
        detail: `Film · ${year} · ${description}`,
        raw: {
          title: label,
          year,
          description,
          wikidataId: result.id,
          url: result.concepturi
        }
      });
    }
  }
  return enrichWikidataMovies(movies.slice(0, 12));
}

async function searchJikanAnimeTitles(query) {
  try {
    const results = [];
    const seen = new Set();
    for (const term of titleSearchVariants(query).slice(0, 4)) {
      const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(term)}&limit=8`);
      if (!response.ok) continue;
      const data = await response.json();
      (data.data || []).forEach((anime) => {
        const title = anime.title_english || anime.title || anime.title_japanese || "";
        const key = `${anime.mal_id}`;
        if (!title || seen.has(key)) return;
        seen.add(key);
        const type = anime.type === "Movie" ? "movie" : "series";
        results.push({
          source: "jikan",
          id: String(anime.mal_id),
          title,
          image: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || "",
          poster: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || "",
          detail: `${type === "movie" ? "Anime-Film" : "Anime-Serie"} · ${anime.year || anime.aired?.from?.slice(0, 4) || "ohne Jahr"} · MyAnimeList`,
          raw: {
            malId: anime.mal_id,
            type,
            title,
            year: anime.year || anime.aired?.from?.slice(0, 4) || "",
            description: anime.synopsis || "",
            poster: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || "",
            rating: anime.score ? `MAL ${Number(anime.score).toFixed(1)}/10` : "",
            genres: (anime.genres || []).map((genre) => genre.name),
            episodes: anime.episodes || null
          }
        });
      });
    }
    return results.slice(0, 10);
  } catch {
    return [];
  }
}

async function fetchGermanSummary(title) {
  const details = await fetchWikipediaDetails(title);
  return details.extract;
}

async function searchTitleSuggestions() {
  const run = ++titleSearchRun;
  const query = $("#titleInput").value.trim();
  if (!query) {
    titleSuggestionCache.clear();
    $("#titleSuggestions").innerHTML = "";
    $("#titleSearchNote").textContent = "Tippe einen Titel ein.";
    return;
  }

  $("#titleSuggestions").innerHTML = "";
  $("#titleSearchNote").textContent = "Suche läuft...";

  try {
    const [tmdbResults, seriesResponse, animeResults, movieResults] = await Promise.allSettled([
      searchTmdbTitles(query),
      fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`),
      searchJikanAnimeTitles(query),
      searchWikidataMovies(query)
    ]);

    const series = seriesResponse.status === "fulfilled" && seriesResponse.value.ok
      ? (await seriesResponse.value.json()).map(({ show }) => {
          const year = show.premiered ? show.premiered.slice(0, 4) : "ohne Jahr";
          const format = [show.type, show.language].filter(Boolean).join(" · ") || "Serie";
          const genres = (show.genres || []).join(", ") || "keine Genres";
          return {
            source: "tvmaze",
            id: String(show.id),
            title: show.name,
            image: show.image?.medium || "",
            detail: `Serie · ${year} · ${format} · ${genres}`
          };
        })
      : [];

    const movies = movieResults.status === "fulfilled"
      ? movieResults.value
      : [];
    const tmdb = tmdbResults.status === "fulfilled"
      ? tmdbResults.value
      : [];
    const anime = animeResults.status === "fulfilled"
      ? animeResults.value
      : [];

    if (run !== titleSearchRun) return;

    titleSuggestionCache.clear();
    const mixed = dedupeMedia([...tmdb.slice(0, 8), ...anime.slice(0, 8), ...series.slice(0, 8), ...movies.slice(0, 12)])
      .slice(0, 16);
    mixed.forEach((item) => titleSuggestionCache.set(`${item.source}:${item.id}`, item));

    if (!mixed.length) throw new Error("Keine Treffer");
    renderTitleSuggestions(mixed);
    $("#titleSearchNote").textContent = `${mixed.length} Vorschläge gefunden.`;
  } catch (error) {
    if (run !== titleSearchRun) return;
    $("#titleSearchNote").textContent = "Keine Vorschläge gefunden oder offline.";
  }
}

function scheduleTitleSuggestions() {
  window.clearTimeout(titleSearchTimer);
  const query = $("#titleInput").value.trim();
  if (!query) {
    titleSuggestionCache.clear();
    $("#titleSuggestions").innerHTML = "";
    $("#titleSearchNote").textContent = "Tippe einen Titel ein.";
    return;
  }
  $("#titleSearchNote").textContent = "Suche gleich...";
  titleSearchTimer = window.setTimeout(searchTitleSuggestions, 300);
}

function showSeriesSuggestions(results) {
  $("#seriesSuggestions").innerHTML = results.map(({ show }) => {
    const year = show.premiered ? show.premiered.slice(0, 4) : "ohne Jahr";
    const genres = (show.genres || []).join(", ") || "keine Genres";
    const network = show.network?.name || show.webChannel?.name || "unbekannte Quelle";
    const format = [show.type, show.language].filter(Boolean).join(" · ") || "Serie";
    const safeImage = safeImageUrl(show.image?.medium);
    const image = safeImage ? `<img src="${escapeHtml(safeImage)}" alt="" referrerpolicy="no-referrer">` : "";
    return `
      <button type="button" class="suggestion" data-show-id="${show.id}">
        <span class="suggestion-poster">${image}</span>
        <span>
          <strong>${escapeHtml(show.name)}</strong>
          <small>${year} · ${escapeHtml(format)} · ${escapeHtml(network)} · ${escapeHtml(genres)}</small>
        </span>
      </button>
    `;
  }).join("");
}

async function searchSeriesSuggestions() {
  const query = $("#titleInput").value.trim();
  if (!query) {
    $("#importNote").textContent = "Bitte erst einen Serientitel eingeben.";
    return;
  }
  $("#seriesSuggestions").innerHTML = "";
  $("#importNote").textContent = "Suche läuft...";
  setEpisodeLoading(true, "Serienvorschläge werden gesucht...");
  try {
    const search = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
    if (!search.ok) throw new Error("Nicht gefunden");
    const results = (await search.json()).slice(0, 8);
    if (!results.length) throw new Error("Keine Treffer");
    showSeriesSuggestions(results);
    $("#importNote").textContent = `${results.length} Vorschläge gefunden. Bitte passenden Titel auswählen.`;
  } catch (error) {
    $("#importNote").textContent = "Keine Vorschläge gefunden oder offline.";
  } finally {
    setEpisodeLoading(false);
  }
}

async function importSelectedSeries(showId) {
  $("#importNote").textContent = "Episoden werden geladen...";
  setEpisodeLoading(true, "Episoden und Metadaten werden geladen...");
  try {
    const response = await fetch(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    if (!response.ok) throw new Error("Nicht gefunden");
    const data = await response.json();
    const episodes = (data._embedded?.episodes || []).map((episode) => ({
      id: `tvmaze-${episode.id}`,
      season: episode.season,
      number: episode.number,
      name: episode.name,
      runtime: episode.runtime || episode.averageRuntime || data.averageRuntime || Number($("#runtimeInput").value) || 45,
      airdate: episode.airdate || "",
      seen: false,
      rating: null,
      watchedAt: "",
      comment: ""
    }));
    const enrichedEpisodes = await enrichEpisodeNames(data.name, episodes);
    $("#titleInput").value = data.name || $("#titleInput").value;
    $("#titleForm").dataset.tvmazeId = String(data.id || showId);
    $("#yearInput").value = data.premiered ? data.premiered.slice(0, 4) : $("#yearInput").value;
    $("#runtimeInput").value = data.averageRuntime || data.runtime || $("#runtimeInput").value;
    $("#genresInput").value = (data.genres || []).join(", ") || $("#genresInput").value;
    const wikiDetails = await fetchWikipediaDetails(data.name, "series");
    $("#descriptionInput").value = safeText(wikiDetails.extract || data.summary || $("#descriptionInput").value);
    $("#posterInput").value = safeImageUrl(data.image?.original || data.image?.medium || wikiDetails.image || $("#posterInput").value);
    renderEpisodeEditor(enrichedEpisodes);
    $("#seriesSuggestions").innerHTML = "";
    $("#importNote").textContent = `${enrichedEpisodes.length} Episoden aus "${data.name}" importiert.`;
  } catch (error) {
    $("#importNote").textContent = "Import fehlgeschlagen.";
  } finally {
    setEpisodeLoading(false);
  }
}

async function enrichCurrentEpisodes() {
  syncVisibleEpisodes();
  const title = $("#titleInput").value.trim();
  if (!title || !formEpisodes.length) {
    $("#importNote").textContent = "Bitte erst eine Serie mit Episoden auswählen.";
    return;
  }
  const before = formEpisodes.filter((episode) => isMissingEpisodeName(episode.name, episode.number)).length;
  const firstMissing = normalizeEpisodesForEditor(formEpisodes).find((episode) => isMissingEpisodeName(episode.name, episode.number))?.number || 1;
  $("#importNote").textContent = "Fehlende Namen werden gesucht...";
  setEpisodeLoading(true, `Episodennamen ab Episode ${firstMissing} werden gesucht...`);
  try {
    const enrichedEpisodes = await enrichEpisodeNames(title, formEpisodes);
    const after = enrichedEpisodes.filter((episode) => isMissingEpisodeName(episode.name, episode.number)).length;
    renderEpisodeEditor(enrichedEpisodes);
    $("#importNote").textContent = before > after
      ? `${before - after} Episodennamen ergänzt. Nochmal klicken lädt den nächsten Block.`
      : "Keine weiteren Episodennamen gefunden.";
  } catch {
    $("#importNote").textContent = "Episodennamen konnten nicht ergänzt werden.";
  } finally {
    setEpisodeLoading(false);
  }
}

async function importSelectedMovie(movie) {
  const wikiDetails = await fetchWikipediaDetails(movie.title, "movie");
  $("#typeInput").value = "movie";
  updateSeriesVisibility();
  $("#titleInput").value = movie.title || $("#titleInput").value;
  $("#yearInput").value = movie.year !== "ohne Jahr" ? movie.year : $("#yearInput").value;
  $("#genresInput").value = $("#genresInput").value || "Film";
  $("#descriptionInput").value = safeText(wikiDetails.extract || movie.description || $("#descriptionInput").value);
  $("#posterInput").value = safeImageUrl(movie.poster || movie.image || wikiDetails.image || $("#posterInput").value);
  $("#externalRatingInput").value = movie.wikidataId ? `Wikidata: ${movie.wikidataId}` : $("#externalRatingInput").value;
  $("#episodeEditor").innerHTML = "";
  $("#titleSuggestions").innerHTML = "";
  $("#titleSearchNote").textContent = `"${movie.title}" übernommen.`;
}

async function importSelectedTmdb(item) {
  const movie = item.raw;
  $("#typeInput").value = movie.type;
  updateSeriesVisibility();
  $("#titleInput").value = movie.title || $("#titleInput").value;
  $("#yearInput").value = movie.year || $("#yearInput").value;
  $("#descriptionInput").value = safeText(movie.description || $("#descriptionInput").value);
  $("#posterInput").value = safeImageUrl(movie.poster || $("#posterInput").value);
  $("#externalRatingInput").value = movie.rating || $("#externalRatingInput").value;
  $("#genresInput").value = $("#genresInput").value || (movie.type === "series" ? "Serie" : "Film");
  if (movie.type === "movie") {
    $("#episodeEditor").innerHTML = "";
  } else {
    $("#importNote").textContent = "Für Episoden bitte zusätzlich Serienvorschläge suchen und passenden TVmaze-Titel auswählen.";
  }
  $("#titleSuggestions").innerHTML = "";
  $("#titleSearchNote").textContent = `"${movie.title}" übernommen.`;
}

async function importSelectedJikan(item) {
  const anime = item.raw;
  $("#typeInput").value = anime.type;
  updateSeriesVisibility();
  $("#titleInput").value = anime.title || $("#titleInput").value;
  $("#yearInput").value = anime.year || $("#yearInput").value;
  $("#descriptionInput").value = safeText(anime.description || $("#descriptionInput").value);
  $("#posterInput").value = safeImageUrl(anime.poster || $("#posterInput").value);
  $("#externalRatingInput").value = anime.rating || $("#externalRatingInput").value;
  $("#genresInput").value = formatTags(["Anime", ...(anime.genres || [])]);
  if (anime.type === "movie") {
    $("#episodeEditor").innerHTML = "";
  } else {
    $("#importNote").textContent = "Für vollständige Episoden bitte zusätzlich Serienvorschläge suchen oder Episodennamen ergänzen.";
  }
  $("#titleSuggestions").innerHTML = "";
  $("#titleSearchNote").textContent = `"${anime.title}" übernommen.`;
}

async function importSelectedTitle(source, id) {
  const item = titleSuggestionCache.get(`${source}:${id}`);
  if (!item) return;

  if (source === "tvmaze") {
    $("#typeInput").value = "series";
    updateSeriesVisibility();
    await importSelectedSeries(id);
    $("#titleSuggestions").innerHTML = "";
    $("#titleSearchNote").textContent = `"${item.title}" übernommen.`;
  }

  if (source === "wikidata") {
    await importSelectedMovie(item.raw);
  }

  if (source === "tmdb") {
    await importSelectedTmdb(item);
  }

  if (source === "jikan") {
    await importSelectedJikan(item);
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  const id = $("#editId").value || crypto.randomUUID();
  const existing = state.titles.find((title) => title.id === id);
  const now = Date.now();
  const title = {
    id,
    title: $("#titleInput").value.trim(),
    type: $("#typeInput").value,
    status: $("#statusInput").value,
    year: $("#yearInput").value,
    runtime: Number($("#runtimeInput").value) || null,
    rating: normalizeRating($("#ratingInput").value),
    watchedAt: $("#watchedAtInput").value,
    rewatchCount: Number($("#rewatchCountInput").value) || 0,
    genres: splitTags($("#genresInput").value),
    cast: splitTags($("#castInput").value),
    moods: splitTags($("#moodsInput").value),
    externalRating: $("#externalRatingInput").value.trim(),
    externalId: existing?.externalId || $("#titleForm").dataset.tvmazeId || "",
    source: existing?.source || ($("#titleForm").dataset.tvmazeId ? "tvmaze" : ""),
    poster: $("#posterInput").value.trim(),
    description: $("#descriptionInput").value.trim(),
    comment: $("#commentInput").value.trim(),
    episodes: $("#typeInput").value === "series" ? collectEpisodes(existing?.episodes || []) : [],
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    plannedAt: existing?.plannedAt || "",
    releaseDate: existing?.releaseDate || ""
  };
  const cleanTitle = sanitizeTitle(title);
  const duplicate = state.titles.find((item) => item.id !== id && isSameMedia(item, cleanTitle));
  if (duplicate) {
    alert(`"${duplicate.title}" ist schon in deiner Sammlung.`);
    return;
  }
  await saveTitle(cleanTitle);
  $("#titleDialog").close();
  await refresh();
}

async function markNextEpisode(id) {
  const title = state.titles.find((item) => item.id === id);
  const next = title?.episodes?.find((episode) => !episode.seen);
  if (!next) return;
  next.seen = true;
  next.watchedAt = new Date().toISOString().slice(0, 10);
  title.status = title.episodes.every((episode) => episode.seen) ? "Abgeschlossen" : "Schaue ich gerade";
  title.updatedAt = Date.now();
  await saveTitle(title);
  await refresh();
}

async function markMovieDone(id) {
  const title = state.titles.find((item) => item.id === id);
  if (!title) return;
  title.status = "Abgeschlossen";
  title.watchedAt ||= new Date().toISOString().slice(0, 10);
  title.updatedAt = Date.now();
  await saveTitle(title);
  await refresh();
}

async function applySwipeAction(action) {
  const candidates = getSwipeCandidates();
  const current = candidates[state.swipeIndex];
  if (!current) return;

  if (action === "no") {
    state.swipeIndex += 1;
    renderSwipe();
    return;
  }

  if (action === "maybe") {
    if (current.source === "new") {
      if (!hasMediaInList([...state.titles, ...state.savedSuggestions], current)) {
        await saveSuggestion(sanitizeSuggestion({
          ...current,
          id: current.id,
          decision: "Vielleicht",
          createdAt: current.createdAt || Date.now(),
          updatedAt: Date.now()
        }));
      }
      state.newSuggestions = state.newSuggestions.filter((item) => item.id !== current.id);
    } else {
      const title = state.titles.find((item) => item.id === current.id);
      if (title) {
        title.status = "Will ich sehen";
        title.updatedAt = Date.now();
        await saveTitle(title);
      }
    }
    state.swipeIndex += 1;
    await refresh();
    return;
  }

  if (action === "yes") {
    if (current.source === "new") {
      if (!hasMediaInList([...state.titles, ...state.savedSuggestions], current)) {
        await saveSuggestion(sanitizeSuggestion({
          ...current,
          id: current.id,
          decision: "Ja",
          createdAt: current.createdAt || Date.now(),
          updatedAt: Date.now()
        }));
      }
      state.newSuggestions = state.newSuggestions.filter((item) => item.id !== current.id);
    } else {
      const title = state.titles.find((item) => item.id === current.id);
      if (title) {
        title.status = state.swipeMode === "rewatch" ? "Rewatch" : "Schaue ich gerade";
        title.updatedAt = Date.now();
        await saveTitle(title);
      }
    }
    state.swipeIndex = Math.min(state.swipeIndex, Math.max(0, getSwipeCandidates().length - 1));
    await refresh();
  }
}

async function addSavedSuggestionToLibrary(id) {
  const suggestion = state.savedSuggestions.find((item) => item.id === id);
  if (!suggestion) return;
  const duplicate = state.titles.find((title) => isSameMedia(title, suggestion));
  if (duplicate) {
    alert(`"${duplicate.title}" ist schon in deiner Sammlung.`);
    await deleteSuggestion(id);
    await refresh();
    return;
  }
  await saveTitle(sanitizeTitle({
    id: crypto.randomUUID(),
    title: suggestion.title,
    type: suggestion.type,
    status: "Will ich sehen",
    year: suggestion.year || "",
    runtime: null,
    rating: null,
    watchedAt: "",
    rewatchCount: 0,
    genres: suggestion.genres || [],
    cast: suggestion.cast || [],
    moods: suggestion.moods || [],
    externalRating: suggestion.externalRating || "",
    poster: suggestion.poster || "",
    description: suggestion.description || "",
    comment: `Aus Swipe-Auswahl übernommen: ${(suggestion.reasons || []).join(", ")}`,
    episodes: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }));
  await deleteSuggestion(id);
  await refresh();
}

function exportData() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), titles: state.titles, suggestions: state.savedSuggestions }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `watch-up-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error("Backup zu groß");
  const text = await file.text();
  const data = JSON.parse(text);
  if (!Array.isArray(data.titles)) throw new Error("Ungültiges Backup");
  await new Promise((resolve, reject) => {
    const request = transaction("readwrite").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const request = transaction("readwrite", SUGGESTION_STORE).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  const cleanTitles = dedupeMedia(data.titles.map(sanitizeTitle).filter((title) => title.title));
  const cleanSuggestions = dedupeMedia((data.suggestions || []).map(sanitizeSuggestion).filter((suggestion) => suggestion.title));
  for (const title of cleanTitles) {
    await saveTitle(title);
  }
  for (const suggestion of cleanSuggestions) {
    await saveSuggestion(suggestion);
  }
  await refresh();
}

function bindEvents() {
  $("#statusInput").innerHTML = statuses.map((status) => `<option>${status}</option>`).join("");
  $("#addTitleBtn").addEventListener("click", () => openDialog());
  $("#closeDialog").addEventListener("click", () => $("#titleDialog").close());
  $("#cancelBtn").addEventListener("click", () => $("#titleDialog").close());
  $("#typeInput").addEventListener("change", updateSeriesVisibility);
  $("#titleForm").addEventListener("submit", handleSubmit);
  $("#titleInput").addEventListener("input", scheduleTitleSuggestions);
  $("#titleSuggestions").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-source][data-id]");
    if (!button) return;
    await importSelectedTitle(button.dataset.source, button.dataset.id);
  });
  $("#importSeriesBtn").addEventListener("click", searchSeriesSuggestions);
  $("#enrichEpisodesBtn").addEventListener("click", enrichCurrentEpisodes);
  $("#seriesSuggestions").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-show-id]");
    if (!button) return;
    await importSelectedSeries(button.dataset.showId);
  });
  $("#deleteBtn").addEventListener("click", async () => {
    const id = $("#editId").value;
    if (!id || !confirm("Diesen Titel wirklich löschen?")) return;
    await deleteTitleEverywhere(id);
    $("#titleDialog").close();
    await refresh();
  });
  $("#searchInput").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderLibrary();
  });
  $("#libraryView .segments").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-kind]");
    if (!button) return;
    state.kind = button.dataset.kind;
    $$("#libraryView .segments button").forEach((item) => item.classList.toggle("active", item === button));
    renderLibrary();
  });
  $("#swipeMode").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-swipe-mode]");
    if (!button) return;
    state.swipeMode = button.dataset.swipeMode;
    state.swipeIndex = 0;
    $$("#swipeMode button").forEach((item) => item.classList.toggle("active", item === button));
    renderSwipe();
  });
  $("#refreshSuggestionsBtn").addEventListener("click", loadNewSuggestions);
  $("#genreSeeds").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-seed]");
    if (!button) return;
    state.discoverySeed = button.dataset.seed;
    $$("#genreSeeds button").forEach((item) => item.classList.toggle("active", item === button));
  });
  $("#swipeNoBtn").addEventListener("click", () => applySwipeAction("no"));
  $("#swipeMaybeBtn").addEventListener("click", () => applySwipeAction("maybe"));
  $("#swipeYesBtn").addEventListener("click", () => applySwipeAction("yes"));
  $("#savedSuggestionList").addEventListener("click", async (event) => {
    const add = event.target.closest("[data-add-suggestion]");
    const remove = event.target.closest("[data-delete-suggestion]");
    if (add) await addSavedSuggestionToLibrary(add.dataset.addSuggestion);
    if (remove) {
      await deleteSuggestion(remove.dataset.deleteSuggestion);
      await refresh();
    }
  });
  $("#swipeDeck").addEventListener("pointerdown", (event) => {
    swipeStartX = event.clientX;
  });
  $("#swipeDeck").addEventListener("pointerup", async (event) => {
    if (swipeStartX === null) return;
    const delta = event.clientX - swipeStartX;
    swipeStartX = null;
    if (Math.abs(delta) < 70) return;
    await applySwipeAction(delta > 0 ? "yes" : "no");
  });
  $("#statusChips").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-status]");
    if (!button) return;
    state.status = button.dataset.status;
    renderLibrary();
  });
  $("#titleGrid").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit]");
    const next = event.target.closest("[data-next]");
    const done = event.target.closest("[data-done]");
    if (edit) openDialog(state.titles.find((title) => title.id === edit.dataset.edit));
    if (next) await markNextEpisode(next.dataset.next);
    if (done) await markMovieDone(done.dataset.done);
  });
  $("#episodeEditor").addEventListener("click", (event) => {
    const seasonButton = event.target.closest(".season-card");
    if (seasonButton) {
      syncVisibleEpisodes();
      selectedSeason = Number(seasonButton.dataset.season);
      renderEpisodeEditor(formEpisodes);
      return;
    }

    const button = event.target.closest(".seen-toggle");
    if (!button) return;
    button.classList.toggle("seen");
    button.textContent = button.classList.contains("seen") ? "Gesehen" : "Offen";
    const date = button.closest(".episode-row").querySelector(".episode-date");
    if (button.classList.contains("seen") && !date.value) date.value = new Date().toISOString().slice(0, 10);
  });
  $("#episodeEditor").addEventListener("input", syncVisibleEpisodes);
  $$(".nav button").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    $$(".nav button").forEach((item) => item.classList.toggle("active", item === button));
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${state.view}View`));
    const labels = {
      library: ["Sammlung", "Tracke Filme, Serien, Episoden und deinen Geschmack."],
      discover: ["Entdecken", "Swipe durch Rewatchs, ungesehene Titel und neue Vorschläge."],
      stats: ["Statistik", "Dein persönlicher Watch-Wrapped-Unterbau."],
      calendar: ["Kalender", "Was als Nächstes offen ist."],
      backup: ["Backup", "Export und Import deiner lokalen Daten."]
    };
    $("#pageTitle").textContent = labels[state.view][0];
    $("#pageSubline").textContent = labels[state.view][1];
  }));
  $("#exportBtn").addEventListener("click", exportData);
  $("#importInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await importData(file);
      alert("Backup importiert.");
    } catch {
      alert("Import fehlgeschlagen.");
    }
  });
  $("#prevMonthBtn").addEventListener("click", () => {
    state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() - 1, 1);
    renderCalendar();
  });
  $("#nextMonthBtn").addEventListener("click", () => {
    state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() + 1, 1);
    renderCalendar();
  });
  $("#todayMonthBtn").addEventListener("click", () => {
    state.calendarDate = new Date();
    renderCalendar();
  });
  $("#calendarGrid").addEventListener("click", (event) => {
    const day = event.target.closest("[data-calendar-date]");
    if (!day) return;
    $("#planDateInput").value = day.dataset.calendarDate;
    $("#calendarPlanPanel").classList.add("pulse");
    $("#calendarPlanPanel").scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => $("#calendarPlanPanel").classList.remove("pulse"), 900);
  });
  $("#planTitleSelect").addEventListener("change", () => {
    $("#planDateInput").value = "";
    renderPlanControls();
  });
  $("#planEpisodeSelect").addEventListener("change", () => {
    $("#planDateInput").value = "";
    renderPlanControls();
  });
  $("#savePlanBtn").addEventListener("click", savePlannedWatch);
  $("#clearPlanBtn").addEventListener("click", clearPlannedWatch);
  $("#addToCalendarBtn").addEventListener("click", addTitleToCalendar);
  $("#calendarIncludedList").addEventListener("click", async (event) => {
    const remove = event.target.closest("[data-calendar-remove]");
    if (!remove) return;
    await removeTitleFromCalendar(remove.dataset.calendarRemove);
  });
  $("#refreshCalendarBtn").addEventListener("click", refreshReleaseDates);
  $("#enableNotifyBtn").addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    await Notification.requestPermission();
    renderNotificationStatus();
    renderCalendar();
  });
  $("#saveTmdbKeyBtn").addEventListener("click", () => {
    const value = $("#tmdbKeyInput").value.trim();
    if (!value || value.includes("•")) {
      setTmdbStatus();
      return;
    }
    localStorage.setItem(TMDB_KEY, value);
    setTmdbStatus();
  });
  $("#clearTmdbKeyBtn").addEventListener("click", () => {
    localStorage.removeItem(TMDB_KEY);
    setTmdbStatus();
  });
  setTmdbStatus();
}

async function seedIfEmpty() {
  if (state.titles.length) return;
  await saveTitle({
    id: crypto.randomUUID(),
    title: "Beispielserie",
    type: "series",
    status: "Schaue ich gerade",
    year: "2026",
    runtime: 45,
    rating: 8,
    genres: ["Drama"],
    cast: [],
    moods: ["spannend"],
    externalRating: "Demo",
    poster: "",
    description: "Eine Beispielserie, damit du den Episoden-Tracker direkt ausprobieren kannst.",
    comment: "Kannst du löschen oder überschreiben.",
    episodes: [
      { id: "demo-1", season: 1, number: 1, name: "Pilot", runtime: 45, seen: true, rating: 8, watchedAt: new Date().toISOString().slice(0, 10), comment: "Guter Start." },
      { id: "demo-2", season: 1, number: 2, name: "Weiter geht's", runtime: 44, seen: false, rating: null, watchedAt: "", comment: "" }
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}

(async function init() {
  db = await openDb();
  bindEvents();
  state.titles = await getAllTitles();
  await seedIfEmpty();
  await refresh();
})();
