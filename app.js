const DB_NAME = "watch-up-db";
const STORE = "titles";
const SUGGESTION_STORE = "suggestions";
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
  discoverySeed: "mix"
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

function deleteSuggestion(id) {
  return new Promise((resolve, reject) => {
    const request = transaction("readwrite", SUGGESTION_STORE).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function refresh() {
  state.titles = await getAllTitles();
  state.savedSuggestions = await getAllSavedSuggestions();
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

function monthLabel(dateValue) {
  if (!dateValue) return "ohne Datum";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "ohne Datum";
  return date.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
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

  const poster = current.poster
    ? `<div class="swipe-poster"><img src="${current.poster}" alt=""></div>`
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
    .filter((item) => !existingTitles.has(item.title.toLowerCase()))
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
  const existingTitles = new Set(state.titles.map((title) => title.title.toLowerCase()));
  state.savedSuggestions.forEach((suggestion) => existingTitles.add(suggestion.title.toLowerCase()));
  const suggestions = curatedSuggestionsForSeed(state.discoverySeed, existingTitles);
  $("#swipeHint").textContent = "Neue Vorschläge werden gesucht...";

  for (const seed of movieSeeds.length ? movieSeeds : discoverySeedMap.mix) {
    const [itunesMovies, wikidataMovies] = await Promise.allSettled([
      searchItunesMovies(seed),
      searchWikidataMovies(seed)
    ]);
    const movies = [
      ...(itunesMovies.status === "fulfilled" ? itunesMovies.value : []),
      ...(wikidataMovies.status === "fulfilled" ? wikidataMovies.value : [])
    ];
    movies.forEach((movie) => {
      if (existingTitles.has(movie.title.toLowerCase())) return;
      suggestions.push({
        id: `suggestion-${movie.source}-${movie.id}`,
        source: "new",
        type: "movie",
        title: movie.title,
        year: movie.year || movie.raw?.year || "",
        genres: movie.genres || ["Film"],
        cast: movie.cast || [],
        moods: movie.moods || [],
        poster: movie.poster || "",
        description: movie.description || movie.raw?.description || "",
        reasons: movie.reasons || [`neuer Filmvorschlag aus ${seed}`],
        rawSuggestion: movie.raw || movie
      });
    });
  }

  for (const seed of seriesSeeds.length ? seriesSeeds : discoverySeedMap.mix) {
    const seriesResponse = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(seed)}`).catch(() => null);
    if (seriesResponse?.ok) {
      const data = await seriesResponse.json();
      data.slice(0, 4).forEach(({ show }) => {
        if (existingTitles.has(show.name.toLowerCase())) return;
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

  const unique = [];
  const seen = new Set();
  suggestions.forEach((suggestion) => {
    const key = suggestion.title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(suggestion);
  });
  state.newSuggestions = unique.slice(0, 20);
  state.swipeMode = "new";
  state.swipeIndex = 0;
  $$("#swipeMode button").forEach((button) => button.classList.toggle("active", button.dataset.swipeMode === "new"));
  renderSwipe();
}

function getLevel(minutes) {
  const levels = [
    ["Gelegenheitsgucker", 600],
    ["Serien-Snacker", 1800],
    ["Prime-Time-Profi", 4500],
    ["Binge-Buddy", 9000],
    ["Watchjunkie", 18000],
    ["Cineast", 36000],
    ["Watch-Legende", 72000]
  ];
  const current = levels.find(([_, limit]) => minutes < limit) || levels[levels.length - 1];
  const previousLimit = levels[Math.max(0, levels.indexOf(current) - 1)]?.[1] || 0;
  const progress = Math.min(100, ((minutes - previousLimit) / (current[1] - previousLimit)) * 100);
  return { name: current[0], next: current[1], progress: Number.isFinite(progress) ? progress : 100 };
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
    const poster = title.poster
      ? `<div class="poster"><img src="${title.poster}" alt=""></div>`
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
  const minutes = state.titles.reduce((sum, title) => sum + getMinutes(title), 0);
  const watchedMovies = state.titles.filter((title) => title.type === "movie" && (title.status === "Abgeschlossen" || title.status === "Rewatch" || title.watchedAt)).length;
  const watchedEpisodes = state.titles.reduce((sum, title) => sum + getWatchedEpisodes(title).length, 0);
  const ratings = state.titles.map((title) => title.rating).filter((rating) => rating !== null && rating !== undefined);
  const average = ratings.length ? (ratings.reduce((sum, rating) => sum + Number(rating), 0) / ratings.length).toFixed(1) : "-";
  const level = getLevel(minutes);
  const events = getWatchEvents();

  $("#statMinutes").textContent = minutes.toLocaleString("de-DE");
  $("#statMovies").textContent = watchedMovies;
  $("#statEpisodes").textContent = watchedEpisodes;
  $("#statAverage").textContent = average;
  $("#watchLevel").textContent = level.name;
  $("#levelMeter").style.width = `${level.progress}%`;
  $("#levelHint").textContent = `${minutes.toLocaleString("de-DE")} Minuten getrackt`;

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
    <p>Du hast bisher <strong>${Math.round(minutes / 60).toLocaleString("de-DE")} Stunden</strong> gesammelt und bist aktuell <strong>${level.name}</strong>.</p>
    <p>Dein stärkstes Genre oder Mood ist gerade <strong>${escapeHtml(topGenre)}</strong>.</p>
    <p>Dein stärkster Monat ist <strong>${escapeHtml(strongestMonth)}</strong>.</p>
    <p>Deine beste Episode ist aktuell <strong>${escapeHtml(bestEpisode)}</strong>.</p>
  `;
}

function renderCalendar() {
  const items = state.titles
    .filter((title) => title.type === "series")
    .map((title) => {
      const next = normalizeEpisodesForEditor(title.episodes || []).find((episode) => !episode.seen);
      return next ? { title, episode: next } : null;
    })
    .filter(Boolean)
    .slice(0, 20);
  $("#calendarList").innerHTML = items.length
    ? items.map(({ title, episode }) => listItem(title.title, `S${episode.season} E${episode.number} · ${episode.name}`)).join("")
    : emptyLine("Keine offenen Episoden");
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
    const fallbackName = tvmazeMatch?.name || kitsuMatch?.name || jikanMatch?.name || `Episode ${episode.number || index + 1}`;
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

function renderTitleSuggestions(results) {
  $("#titleSuggestions").innerHTML = results.map((item) => `
    <button type="button" class="suggestion" data-source="${item.source}" data-id="${item.id}">
      <span class="suggestion-poster">${item.image ? `<img src="${item.image}" alt="">` : ""}</span>
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.detail)}</small>
      </span>
    </button>
  `).join("");
}

async function searchWikidataMovies(query) {
  const searches = [query, `${query} film`, `${query} movie`];
  const responses = await Promise.all(searches.map((term) =>
    fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(term)}&language=de&format=json&limit=12&origin=*`)
  ));

  const seen = new Set();
  const movies = [];
  for (const response of responses) {
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
  return movies.slice(0, 12);
}

async function fetchGermanSummary(title) {
  const variants = [title, `${title} (Fernsehserie)`, `${title} (Film)`];
  for (const variant of variants) {
    try {
      const response = await fetch(`https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(variant)}`);
      if (!response.ok) continue;
      const data = await response.json();
      if (data.extract && data.type !== "disambiguation") return data.extract;
    } catch {
      continue;
    }
  }
  return "";
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
    const [seriesResponse, movieResults] = await Promise.allSettled([
      fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`),
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

    if (run !== titleSearchRun) return;

    titleSuggestionCache.clear();
    const mixed = [...series.slice(0, 8), ...movies.slice(0, 12)].slice(0, 16);
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
    const image = show.image?.medium ? `<img src="${show.image.medium}" alt="">` : "";
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
    $("#yearInput").value = data.premiered ? data.premiered.slice(0, 4) : $("#yearInput").value;
    $("#runtimeInput").value = data.averageRuntime || data.runtime || $("#runtimeInput").value;
    $("#genresInput").value = (data.genres || []).join(", ") || $("#genresInput").value;
    const germanSummary = await fetchGermanSummary(data.name);
    $("#descriptionInput").value = germanSummary || (data.summary || "").replace(/<[^>]+>/g, "") || $("#descriptionInput").value;
    $("#posterInput").value = data.image?.original || data.image?.medium || $("#posterInput").value;
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
  const germanSummary = await fetchGermanSummary(movie.title);
  $("#typeInput").value = "movie";
  updateSeriesVisibility();
  $("#titleInput").value = movie.title || $("#titleInput").value;
  $("#yearInput").value = movie.year !== "ohne Jahr" ? movie.year : $("#yearInput").value;
  $("#genresInput").value = $("#genresInput").value || "Film";
  $("#descriptionInput").value = germanSummary || movie.description || $("#descriptionInput").value;
  $("#externalRatingInput").value = movie.wikidataId ? `Wikidata: ${movie.wikidataId}` : $("#externalRatingInput").value;
  $("#episodeEditor").innerHTML = "";
  $("#titleSuggestions").innerHTML = "";
  $("#titleSearchNote").textContent = `"${movie.title}" übernommen.`;
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
    poster: $("#posterInput").value.trim(),
    description: $("#descriptionInput").value.trim(),
    comment: $("#commentInput").value.trim(),
    episodes: $("#typeInput").value === "series" ? collectEpisodes(existing?.episodes || []) : [],
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await saveTitle(title);
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
      await saveSuggestion({
        ...current,
        id: current.id,
        decision: "Vielleicht",
        createdAt: current.createdAt || Date.now(),
        updatedAt: Date.now()
      });
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
      await saveSuggestion({
        ...current,
        id: current.id,
        decision: "Ja",
        createdAt: current.createdAt || Date.now(),
        updatedAt: Date.now()
      });
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
  await saveTitle({
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
    externalRating: "",
    poster: suggestion.poster || "",
    description: suggestion.description || "",
    comment: `Aus Swipe-Auswahl übernommen: ${(suggestion.reasons || []).join(", ")}`,
    episodes: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
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
  for (const title of data.titles) {
    await saveTitle(title);
  }
  for (const suggestion of data.suggestions || []) {
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
    await deleteTitle(id);
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
