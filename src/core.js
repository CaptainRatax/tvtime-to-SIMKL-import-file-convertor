#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP_NAME = 'tvtime-to-SIMKL-import-file-convertor';
const DEFAULT_INPUT = 'gdpr-data.zip';
const DEFAULT_OUTPUT_DIR = 'output';
const SIMKL_INTERNAL_JSON_NAME = 'SimklBackup.json';

const EPISODE_SOURCES = [
  { file: 'tracking-prod-records-v2.csv', kind: 'tracking-v2' },
  { file: 'watched_on_episode.csv', kind: 'simple-watch' },
  { file: 'seen_episode.csv', kind: 'simple-watch' },
  { file: 'seen_episode_unitarian.csv', kind: 'simple-watch' },
];

const RATING_SOURCES = [
  'ratings-3-prod-episode_votes.csv',
  'ratings-live-votes.csv',
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const inputZipPath = path.resolve(options.input || DEFAULT_INPUT);
  const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR);

  if (!fs.existsSync(inputZipPath)) {
    throw new Error(`Input file not found: ${inputZipPath}`);
  }

  const timestamp = makeTimestamp(new Date());
  const runDir = path.join(outputDir, `simkl-json-import-${timestamp}`);

  console.log(APP_NAME);
  console.log(`Input:  ${inputZipPath}`);
  console.log(`Output: ${runDir}`);
  console.log('');

  const zip = ZipArchive.fromFile(inputZipPath);
  const loaded = loadTvTimeData(zip);
  const progress = new Progress(estimateWork(loaded), options.progressIntervalMs);

  progress.status('preparing conversion', true);
  const result = convertTvTimeToSimklJson(loaded, options, progress);
  progress.status('writing files', true);

  fs.mkdirSync(runDir, { recursive: true });

  const jsonPath = path.join(runDir, `SimklBackup-${timestamp}.json`);
  const zipPath = path.join(runDir, `SimklBackup-${timestamp}.zip`);
  const failedCsvPath = path.join(runDir, `failed-records-${timestamp}.csv`);
  const failedMdPath = path.join(runDir, `failed-records-${timestamp}.md`);
  const summaryPath = path.join(runDir, `summary-${timestamp}.json`);

  const jsonText = `${JSON.stringify(result.simklBackup, null, 2)}\n`;
  fs.writeFileSync(jsonPath, jsonText, 'utf8');
  fs.writeFileSync(zipPath, createZip([{ name: SIMKL_INTERNAL_JSON_NAME, data: Buffer.from(jsonText, 'utf8') }]));
  fs.writeFileSync(failedCsvPath, renderReportCsv(result.reportRows), 'utf8');
  fs.writeFileSync(failedMdPath, renderReportMarkdown(result.reportRows, result.summary), 'utf8');
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    app: APP_NAME,
    generated_at: new Date().toISOString(),
    input: inputZipPath,
    output: {
      directory: runDir,
      json: jsonPath,
      zip: zipPath,
      failed_csv: failedCsvPath,
      failed_markdown: failedMdPath,
    },
    notes: result.notes,
    counts: result.summary,
  }, null, 2)}\n`, 'utf8');

  progress.done = progress.total;
  progress.status('completed', true);

  printSummaryTable(result.summary);
  console.log('');
  console.log(`Generated JSON: ${jsonPath}`);
  console.log(`SIMKL import ZIP: ${zipPath}`);
  console.log(`Failure/warning report: ${failedMdPath}`);
  console.log(`Technical summary: ${summaryPath}`);
  console.log('');
  console.log('Note: the generated ZIP contains an internal file named SimklBackup.json.');
}

function parseArgs(args) {
  const options = {
    input: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    includePlanToWatch: true,
    includeRewatches: true,
    progressIntervalMs: 1000,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--input' || arg === '-i') {
      options.input = requireValue(args, ++i, arg);
    } else if (arg === '--output-dir' || arg === '-o') {
      options.outputDir = requireValue(args, ++i, arg);
    } else if (arg === '--progress-interval') {
      const value = Number(requireValue(args, ++i, arg));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--progress-interval must be a millisecond value >= 0');
      }
      options.progressIntervalMs = value;
    } else if (arg === '--no-plan-to-watch') {
      options.includePlanToWatch = false;
    } else if (arg === '--no-rewatches') {
      options.includeRewatches = false;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.input) {
      options.input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(args, index, flag) {
  if (index >= args.length || args[index].startsWith('-')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return args[index];
}

function printHelp() {
  console.log(`${APP_NAME}

Usage:
  node index.js [tvtime-export.zip] [options]

Options:
  -i, --input <zip>              TV Time exported .zip file. Default: ${DEFAULT_INPUT}
  -o, --output-dir <folder>      Output folder. Default: ${DEFAULT_OUTPUT_DIR}
      --progress-interval <ms>   Minimum interval between status lines. Use 0 to show phase changes only.
      --no-plan-to-watch         Do not export followed/plan-to-watch items
      --no-rewatches             Do not export rewatch sessions
  -h, --help                     Show help

Outputs:
  - SimklBackup-<timestamp>.json
  - SimklBackup-<timestamp>.zip, containing SimklBackup.json
  - failed-records-<timestamp>.md/.csv
  - summary-<timestamp>.json`);
}

function loadTvTimeData(zip) {
  const files = {};
  const allFiles = new Set([
    ...EPISODE_SOURCES.map((source) => source.file),
    'rewatched_episode.csv',
    'followed_tv_show.csv',
    'user_tv_show_data.csv',
    'tracking-prod-records.csv',
    ...RATING_SOURCES,
  ]);

  for (const file of allFiles) {
    const entry = zip.getEntry(file);
    if (!entry) {
      files[file] = { file, headers: [], rows: [], warnings: [], exists: false };
      continue;
    }

    const parsed = parseCsv(zip.readText(file));
    files[file] = {
      file,
      headers: parsed.headers,
      rows: parsed.rows,
      warnings: parsed.warnings,
      exists: true,
    };
  }

  return { files };
}

function estimateWork(loaded) {
  return Object.values(loaded.files).reduce((total, file) => total + file.rows.length, 0) + 1;
}

function convertTvTimeToSimklJson(loaded, options, progress) {
  const shows = new Map();
  const rewatchShows = new Map();
  const movies = new Map();
  const plannedMovies = new Map();
  const rewatchMovies = new Map();
  const reportRows = [];

  for (const file of Object.values(loaded.files)) {
    for (const warning of file.warnings) {
      reportRows.push(makeReport({
        source: file.file,
        row: warning.row,
        type: 'csv',
        reason: warning.reason,
        action: 'parsed with padding/truncation',
      }));
    }
  }

  progress.status('watched episodes', true);
  for (const source of EPISODE_SOURCES) {
    const file = loaded.files[source.file];
    for (const [index, row] of file.rows.entries()) {
      if (source.kind === 'tracking-v2') {
        processTrackingEpisodeRow(row, index + 2, source.file, shows, rewatchShows, reportRows, options);
      } else {
        processSimpleEpisodeRow(row, index + 2, source.file, shows, reportRows);
      }
      progress.tick(1, 'watched episodes');
    }
  }

  progress.status('episode rewatches', true);
  const legacyRewatchFile = loaded.files['rewatched_episode.csv'];
  const hasTrackingV2Rewatches = loaded.files['tracking-prod-records-v2.csv'].rows.some((row) => String(row.key || '').startsWith('rewatch-episode-'));
  let ignoredLegacyRewatchRows = 0;
  for (const [index, row] of legacyRewatchFile.rows.entries()) {
    if (options.includeRewatches && !hasTrackingV2Rewatches) {
      processLegacyRewatchRow(row, index + 2, legacyRewatchFile.file, rewatchShows, reportRows);
    } else if (hasTrackingV2Rewatches) {
      ignoredLegacyRewatchRows += 1;
    }
    progress.tick(1, 'episode rewatches');
  }

  progress.status('followed TV shows', true);
  for (const fileName of ['followed_tv_show.csv', 'user_tv_show_data.csv']) {
    const file = loaded.files[fileName];
    for (const [index, row] of file.rows.entries()) {
      if (options.includePlanToWatch) {
        processFollowedShowRow(row, index + 2, fileName, shows, reportRows);
      }
      progress.tick(1, 'followed TV shows');
    }
  }

  progress.status('movies', true);
  const movieFile = loaded.files['tracking-prod-records.csv'];
  let ignoredMovieCounterRows = 0;
  for (const [index, row] of movieFile.rows.entries()) {
    const result = processMovieRow(row, index + 2, movieFile.file, movies, plannedMovies, rewatchMovies, reportRows, options);
    if (result === 'counter') {
      ignoredMovieCounterRows += 1;
    }
    progress.tick(1, 'movies');
  }

  progress.status('ratings', true);
  let unsupportedRatings = 0;
  for (const fileName of RATING_SOURCES) {
    const file = loaded.files[fileName];
    for (const row of file.rows) {
      unsupportedRatings += 1;
      progress.tick(1, 'ratings');
    }
  }

  const showEntries = [];
  for (const show of sortByTitle(shows.values())) {
    if (show.episodeCount > 0) {
      showEntries.push(toShowEntry(show, { status: 'watching', isRewatch: false }));
    } else if (options.includePlanToWatch) {
      showEntries.push(toPlanToWatchShowEntry(show));
    }
  }

  if (options.includeRewatches) {
    for (const show of sortByTitle(rewatchShows.values())) {
      if (show.episodeCount > 0) {
        showEntries.push(toShowEntry(show, { status: 'watching', isRewatch: true }));
      }
    }
  }

  const movieEntries = [];
  for (const movie of sortByTitle(movies.values())) {
    movieEntries.push(toMovieEntry(movie, { status: 'completed', isRewatch: false }));
  }

  if (options.includePlanToWatch) {
    const watchedMovieKeys = new Set([...movies.values()].map((movie) => movie.baseKey));
    for (const movie of sortByTitle(plannedMovies.values())) {
      if (!watchedMovieKeys.has(movie.baseKey)) {
        movieEntries.push(toMovieEntry(movie, { status: 'plantowatch', isRewatch: false }));
      }
    }
  }

  if (options.includeRewatches) {
    for (const movie of sortByTitle(rewatchMovies.values())) {
      movieEntries.push(toMovieEntry(movie, { status: 'completed', isRewatch: true }));
    }
  }

  const summary = {
    shows: showEntries.filter((entry) => !entry.is_rewatch && entry.status !== 'plantowatch').length,
    show_episodes: countEpisodesInEntries(showEntries.filter((entry) => !entry.is_rewatch)),
    show_rewatch_entries: showEntries.filter((entry) => entry.is_rewatch).length,
    show_rewatch_episodes: countEpisodesInEntries(showEntries.filter((entry) => entry.is_rewatch)),
    shows_plan_to_watch: showEntries.filter((entry) => entry.status === 'plantowatch').length,
    anime: 0,
    movies_completed: movieEntries.filter((entry) => !entry.is_rewatch && entry.status === 'completed').length,
    movie_rewatch_entries: movieEntries.filter((entry) => entry.is_rewatch).length,
    movies_plan_to_watch: movieEntries.filter((entry) => entry.status === 'plantowatch').length,
    unsupported_ratings: unsupportedRatings,
    ignored_movie_counter_rows: ignoredMovieCounterRows,
    ignored_legacy_rewatch_rows: ignoredLegacyRewatchRows,
    failed_rows: reportRows.filter((row) => ['not converted', 'not applied'].includes(row.action)).length,
    report_rows: reportRows.length,
  };

  const notes = [
    'The main output is JSON/ZIP for SIMKL JSON import.',
    'The ZIP contains SimklBackup.json internally, even though the outer filename has a timestamp.',
    'TV Time ratings are counted in the summary, but they are not added to the JSON or failure report.',
    'The TV Time export does not include public SIMKL/TMDB/TVDB/IMDB IDs in most CSV files used here, so the JSON uses titles and years when available.',
    'Anime starts empty because the TV Time export does not identify anime reliably offline.',
  ];

  return {
    simklBackup: {
      shows: showEntries,
      anime: [],
      movies: movieEntries,
    },
    reportRows,
    summary,
    notes,
  };
}

function processTrackingEpisodeRow(row, rowNumber, sourceFile, shows, rewatchShows, reportRows, options) {
  const key = String(row.key || '');
  const isWatch = key.startsWith('watch-episode-');
  const isRewatch = key.startsWith('rewatch-episode-');

  if (!isWatch && !isRewatch) {
    return;
  }

  if (isRewatch && !options.includeRewatches) {
    return;
  }

  const title = cleanTitle(row.series_name);
  const season = trackingSeasonNumber(row);
  const episode = firstPositiveInteger(row.episode_number, row.ep_no);
  const watchedAt = normalizeDate(row.created_at || row.updated_at);

  if (!isValidEpisode(title, season, episode, watchedAt)) {
    reportRows.push(makeInvalidEpisodeReport({
      source: sourceFile,
      row: rowNumber,
      type: isRewatch ? 'TV show rewatch episode' : 'TV show episode',
      title,
      season: row.season_number || '',
      episode: row.episode_number || row.ep_no || '',
      computedSeason: season,
      computedEpisode: episode,
      watchedAt,
      rawFields: {
        season_number: row.season_number,
        s_no: row.s_no,
        episode_number: row.episode_number,
        ep_no: row.ep_no,
        episode_id: row.episode_id || row.ep_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    }));
    return;
  }

  if (isRewatch) {
    const rewatchIndex = extractTrailingNumber(key) || 1;
    const show = getShow(rewatchShows, `${normalizeKey(title)}::rewatch-${rewatchIndex}`, title);
    show.rewatchIndex = rewatchIndex;
    addEpisode(show, season, episode, watchedAt, sourceFile);
    return;
  }

  addEpisode(getShow(shows, normalizeKey(title), title), season, episode, watchedAt, sourceFile);
}

function processSimpleEpisodeRow(row, rowNumber, sourceFile, shows, reportRows) {
  const title = cleanTitle(row.tv_show_name);
  const season = asInteger(row.episode_season_number);
  const episode = asInteger(row.episode_number);
  const watchedAt = normalizeDate(row.created_at || row.updated_at);

  if (!isValidEpisode(title, season, episode, watchedAt)) {
    reportRows.push(makeInvalidEpisodeReport({
      source: sourceFile,
      row: rowNumber,
      type: 'TV show episode',
      title,
      season: row.episode_season_number || '',
      episode: row.episode_number || '',
      computedSeason: season,
      computedEpisode: episode,
      watchedAt,
      rawFields: {
        episode_season_number: row.episode_season_number,
        episode_number: row.episode_number,
        episode_id: row.episode_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    }));
    return;
  }

  addEpisode(getShow(shows, normalizeKey(title), title), season, episode, watchedAt, sourceFile);
}

function processLegacyRewatchRow(row, rowNumber, sourceFile, rewatchShows, reportRows) {
  const title = cleanTitle(row.tv_show_name);
  const season = asInteger(row.episode_season_number);
  const episode = asInteger(row.episode_number);
  const watchedAt = normalizeDate(row.updated_at || row.created_at);
  const rewatchIndex = Math.max(1, asInteger(row.cpt) || 1);

  if (!isValidEpisode(title, season, episode, watchedAt)) {
    reportRows.push(makeInvalidEpisodeReport({
      source: sourceFile,
      row: rowNumber,
      type: 'TV show rewatch episode',
      title,
      season: row.episode_season_number || '',
      episode: row.episode_number || '',
      computedSeason: season,
      computedEpisode: episode,
      watchedAt,
      rawFields: {
        episode_season_number: row.episode_season_number,
        episode_number: row.episode_number,
        episode_id: row.episode_id,
        cpt: row.cpt,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    }));
    return;
  }

  const show = getShow(rewatchShows, `${normalizeKey(title)}::legacy-rewatch-${rewatchIndex}`, title);
  show.rewatchIndex = rewatchIndex;
  addEpisode(show, season, episode, watchedAt, sourceFile);
}

function processFollowedShowRow(row, rowNumber, sourceFile, shows, reportRows) {
  const title = cleanTitle(row.tv_show_name);
  if (!title) {
    reportRows.push(makeReport({
      source: sourceFile,
      row: rowNumber,
      type: 'TV show watchlist',
      reason: 'missing title',
      action: 'not converted',
    }));
    return;
  }

  const show = getShow(shows, normalizeKey(title), title);
  const followedAt = normalizeDate(row.created_at || row.followed_at || row.updated_at);
  if (followedAt) {
    updateMinDate(show, 'addedAt', followedAt);
  }
  show.sources.add(sourceFile);
}

function processMovieRow(row, rowNumber, sourceFile, movies, plannedMovies, rewatchMovies, reportRows, options) {
  const type = cleanText(row.type);
  const entityType = cleanText(row.entity_type);

  if (entityType && entityType !== 'movie') {
    return 'ignored';
  }

  if (type === 'rewatch_count') {
    return 'counter';
  }

  if (!['watch', 'rewatch', 'towatch', 'follow'].includes(type)) {
    return 'ignored';
  }

  const title = cleanTitle(row.movie_name);
  const year = yearFromDate(row.release_date);
  const watchedAt = normalizeDate(row.created_at || row.updated_at);

  if (!title) {
    reportRows.push(makeReport({
      source: sourceFile,
      row: rowNumber,
      type: `movie ${type}`,
      year: year || '',
      reason: 'missing movie title',
      action: 'not converted',
    }));
    return 'failed';
  }

  const baseKey = movieBaseKey(title, year);

  if (type === 'watch') {
    const movie = getMovie(movies, baseKey, title, year);
    addMovieWatch(movie, watchedAt, sourceFile);
    return 'converted';
  }

  if (type === 'rewatch') {
    if (!options.includeRewatches) {
      return 'ignored';
    }
    const rewatchIndex = Math.max(1, asInteger(row.rewatch_count) || rewatchMovies.size + 1);
    const movie = getMovie(rewatchMovies, `${baseKey}::rewatch-${rewatchIndex}-${row.uuid || rowNumber}`, title, year);
    movie.baseKey = baseKey;
    movie.rewatchIndex = rewatchIndex;
    addMovieWatch(movie, watchedAt, sourceFile);

    if (!movies.has(baseKey)) {
      addMovieWatch(getMovie(movies, baseKey, title, year), watchedAt, sourceFile);
    }
    return 'converted';
  }

  if ((type === 'towatch' || type === 'follow') && options.includePlanToWatch) {
    const movie = getMovie(plannedMovies, baseKey, title, year);
    if (watchedAt) {
      updateMinDate(movie, 'addedAt', watchedAt);
    }
    movie.sources.add(sourceFile);
    return 'converted';
  }

  return 'ignored';
}

function isValidEpisode(title, season, episode, watchedAt) {
  return Boolean(title) &&
    Number.isInteger(season) &&
    season >= 0 &&
    Number.isInteger(episode) &&
    episode >= 1 &&
    Boolean(watchedAt);
}

function trackingSeasonNumber(row) {
  const positiveSeason = firstPositiveInteger(row.season_number, row.s_no);
  if (Number.isInteger(positiveSeason)) {
    return positiveSeason;
  }

  const season = asInteger(row.season_number);
  if (Number.isInteger(season)) {
    return season;
  }

  return asInteger(row.s_no);
}

function getShow(map, key, title) {
  let show = map.get(key);
  if (!show) {
    show = {
      key,
      title,
      seasons: new Map(),
      episodeCount: 0,
      addedAt: null,
      lastWatchedAt: null,
      rewatchIndex: null,
      sources: new Set(),
    };
    map.set(key, show);
  }
  return show;
}

function addEpisode(show, seasonNumber, episodeNumber, watchedAt, sourceFile) {
  if (!show.seasons.has(seasonNumber)) {
    show.seasons.set(seasonNumber, new Map());
  }

  const episodes = show.seasons.get(seasonNumber);
  const previous = episodes.get(episodeNumber);
  if (!previous) {
    show.episodeCount += 1;
    episodes.set(episodeNumber, watchedAt);
  } else if (watchedAt < previous) {
    episodes.set(episodeNumber, watchedAt);
  }

  updateMinDate(show, 'addedAt', watchedAt);
  updateMaxDate(show, 'lastWatchedAt', watchedAt);
  show.sources.add(sourceFile);
}

function getMovie(map, key, title, year) {
  let movie = map.get(key);
  if (!movie) {
    movie = {
      key,
      baseKey: movieBaseKey(title, year),
      title,
      year: year || null,
      addedAt: null,
      lastWatchedAt: null,
      rewatchIndex: null,
      sources: new Set(),
    };
    map.set(key, movie);
  }
  return movie;
}

function addMovieWatch(movie, watchedAt, sourceFile) {
  if (watchedAt) {
    updateMinDate(movie, 'addedAt', watchedAt);
    updateMaxDate(movie, 'lastWatchedAt', watchedAt);
  }
  movie.sources.add(sourceFile);
}

function toShowEntry(show, options) {
  const seasons = [...show.seasons.entries()]
    .sort(([left], [right]) => left - right)
    .map(([number, episodes]) => ({
      number,
      episodes: [...episodes.entries()]
        .sort(([left], [right]) => left - right)
        .map(([episodeNumber, watchedAt]) => ({
          number: episodeNumber,
          watched_at: watchedAt,
        })),
    }));

  const entry = {
    added_to_watchlist_at: show.addedAt,
    last_watched_at: show.lastWatchedAt,
    user_rated_at: null,
    user_rating: null,
    status: options.status,
    last_watched: findLastEpisodeCode(seasons),
    next_to_watch: null,
    watched_episodes_count: show.episodeCount,
    total_episodes_count: show.episodeCount,
    not_aired_episodes_count: 0,
    show: {
      title: show.title,
    },
    is_rewatch: Boolean(options.isRewatch),
    seasons,
  };

  if (options.isRewatch) {
    entry.rewatch_status = 'completed';
    if (show.rewatchIndex) {
      entry.rewatch_id = show.rewatchIndex;
    }
  }

  return entry;
}

function toPlanToWatchShowEntry(show) {
  return {
    added_to_watchlist_at: show.addedAt,
    last_watched_at: null,
    user_rated_at: null,
    user_rating: null,
    status: 'plantowatch',
    last_watched: null,
    next_to_watch: null,
    watched_episodes_count: 0,
    total_episodes_count: 0,
    not_aired_episodes_count: 0,
    show: {
      title: show.title,
    },
    is_rewatch: false,
  };
}

function toMovieEntry(movie, options) {
  const media = { title: movie.title };
  if (movie.year) {
    media.year = movie.year;
  }

  const entry = {
    added_to_watchlist_at: movie.addedAt,
    last_watched_at: options.status === 'completed' ? movie.lastWatchedAt : null,
    user_rated_at: null,
    user_rating: null,
    status: options.status,
    watched_episodes_count: options.status === 'completed' ? 1 : 0,
    total_episodes_count: 1,
    not_aired_episodes_count: 0,
    movie: media,
    is_rewatch: Boolean(options.isRewatch),
  };

  if (options.isRewatch) {
    entry.rewatch_status = 'completed';
    if (movie.rewatchIndex) {
      entry.rewatch_id = movie.rewatchIndex;
    }
  }

  return entry;
}

function findLastEpisodeCode(seasons) {
  let lastSeason = null;
  let lastEpisode = null;

  for (const season of seasons) {
    for (const episode of season.episodes) {
      if (
        lastSeason === null ||
        season.number > lastSeason ||
        (season.number === lastSeason && episode.number > lastEpisode)
      ) {
        lastSeason = season.number;
        lastEpisode = episode.number;
      }
    }
  }

  if (lastSeason === null) {
    return null;
  }

  return `S${String(lastSeason).padStart(2, '0')}E${String(lastEpisode).padStart(2, '0')}`;
}

function countEpisodesInEntries(entries) {
  let total = 0;
  for (const entry of entries) {
    for (const season of entry.seasons || []) {
      total += (season.episodes || []).length;
    }
  }
  return total;
}

function makeReport(values) {
  return {
    source: values.source || '',
    row: values.row || '',
    type: values.type || '',
    title: values.title || '',
    season: values.season || '',
    episode: values.episode || '',
    year: values.year || '',
    reason: values.reason || '',
    details: values.details || '',
    suggestion: values.suggestion || '',
    action: values.action || '',
  };
}

function makeInvalidEpisodeReport(values) {
  const issues = [];
  if (!values.title) {
    issues.push('missing title');
  }
  if (!Number.isInteger(values.computedSeason)) {
    issues.push('missing season number');
  } else if (values.computedSeason < 0) {
    issues.push('negative season number');
  }
  if (!Number.isInteger(values.computedEpisode)) {
    issues.push('missing episode number');
  } else if (values.computedEpisode < 1) {
    issues.push('episode number is 0');
  }
  if (!values.watchedAt) {
    issues.push('missing or invalid watched date');
  }

  const rawDetails = Object.entries(values.rawFields || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');

  const computed = [
    `computed_season=${displayValue(values.computedSeason)}`,
    `computed_episode=${displayValue(values.computedEpisode)}`,
    `watched_at=${values.watchedAt || 'invalid'}`,
  ].join(', ');

  let suggestion = 'Check this item manually in TV Time/SIMKL before importing.';
  if (issues.includes('episode number is 0') || issues.includes('missing episode number')) {
    suggestion = 'Skipped to avoid importing a fake E00 episode. Needs a real episode number or manual mapping.';
  } else if (issues.includes('missing or invalid watched date')) {
    suggestion = 'Skipped because SIMKL history needs a valid watched_at date.';
  } else if (issues.includes('missing title')) {
    suggestion = 'Skipped because the TV show title is missing.';
  }

  return makeReport({
    source: values.source,
    row: values.row,
    type: values.type,
    title: values.title,
    season: values.season,
    episode: values.episode,
    reason: issues.join('; ') || 'invalid episode row',
    details: `TV Time raw values: ${rawDetails || 'none'}. ${computed}.`,
    suggestion,
    action: 'not converted',
  });
}

function renderReportCsv(records) {
  const headers = ['source', 'row', 'type', 'title', 'season', 'episode', 'year', 'reason', 'details', 'suggestion', 'action'];
  const lines = [headers.join(',')];
  for (const record of records) {
    lines.push(headers.map((header) => csvEscape(record[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function renderReportMarkdown(records, summary) {
  const lines = [
    '# Conversion report',
    '',
    '## Summary',
    '',
    '| Metric | Count |',
    '| --- | ---: |',
  ];

  for (const [key, value] of Object.entries(summary)) {
    lines.push(`| ${markdownEscape(key)} | ${value} |`);
  }

  lines.push('', '## Failed records and warnings', '');

  if (!records.length) {
    lines.push('No failed records or warnings.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('| Source | Row | Type | Title | Season | Episode | Reason | Details | Suggestion | Action |');
  lines.push('| --- | ---: | --- | --- | ---: | ---: | --- | --- | --- | --- |');
  for (const record of records) {
    lines.push(`| ${markdownEscape(record.source)} | ${record.row} | ${markdownEscape(record.type)} | ${markdownEscape(record.title)} | ${markdownEscape(record.season)} | ${markdownEscape(record.episode)} | ${markdownEscape(record.reason)} | ${markdownEscape(record.details)} | ${markdownEscape(record.suggestion)} | ${markdownEscape(record.action)} |`);
  }

  return `${lines.join('\n')}\n`;
}

function printSummaryTable(summary) {
  const rows = [
    ['Converted TV shows', summary.shows],
    ['Watched episodes', summary.show_episodes],
    ['TV show rewatch entries', summary.show_rewatch_entries],
    ['Rewatch episodes', summary.show_rewatch_episodes],
    ['TV shows plan-to-watch', summary.shows_plan_to_watch],
    ['Anime', summary.anime],
    ['Watched movies', summary.movies_completed],
    ['Movie rewatch entries', summary.movie_rewatch_entries],
    ['Movies plan-to-watch', summary.movies_plan_to_watch],
    ['Ignored ratings', summary.unsupported_ratings],
    ['Failed rows', summary.failed_rows],
    ['Report rows', summary.report_rows],
  ];

  printBoxTable('Final summary', ['Category', 'Total'], rows);
}

function printBoxTable(title, headers, rows) {
  const widths = headers.map((header, index) => {
    const rowWidth = Math.max(...rows.map((row) => String(row[index]).length));
    return Math.max(String(header).length, rowWidth);
  });
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;

  console.log(title);
  console.log(border);
  console.log(`| ${String(headers[0]).padEnd(widths[0])} | ${String(headers[1]).padStart(widths[1])} |`);
  console.log(border);
  for (const [label, count] of rows) {
    console.log(`| ${String(label).padEnd(widths[0])} | ${String(count).padStart(widths[1])} |`);
  }
  console.log(border);
}

function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      if (next === '\n') continue;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  while (rows.length && rows[rows.length - 1].every((value) => value === '')) {
    rows.pop();
  }

  const headers = (rows.shift() || []).map((header) => header.trim());
  const warnings = [];
  const objects = rows.map((values, index) => {
    if (values.length !== headers.length) {
      warnings.push({
        row: index + 2,
        reason: `CSV row has ${values.length} fields, expected ${headers.length}`,
      });
    }

    const object = {};
    for (let i = 0; i < headers.length; i += 1) {
      object[headers[i]] = values[i] ?? '';
    }
    if (values.length > headers.length) {
      object._extra = values.slice(headers.length);
    }
    return object;
  });

  return { headers, rows: objects, warnings };
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function markdownEscape(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .slice(0, 260);
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanTitle(value) {
  return cleanText(value).replace(/\s+/g, ' ');
}

function displayValue(value) {
  return value === null || value === undefined ? 'missing' : String(value);
}

function normalizeKey(value) {
  return cleanTitle(value).toLocaleLowerCase('en-US');
}

function asInteger(value) {
  const text = cleanText(value);
  if (!/^-?\d+$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 10);
}

function firstInteger(...values) {
  for (const value of values) {
    const parsed = asInteger(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const parsed = asInteger(value);
    if (Number.isInteger(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return null;
}

function extractTrailingNumber(value) {
  const match = String(value || '').match(/-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function yearFromDate(value) {
  const match = cleanText(value).match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function movieBaseKey(title, year) {
  return `${normalizeKey(title)}::${year || ''}`;
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }

  let isoLike = text;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    isoLike = `${text.replace(' ', 'T')}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    isoLike = `${text}T00:00:00Z`;
  } else if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    isoLike = `${text.replace(' ', 'T')}Z`;
  }

  const date = new Date(isoLike);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function updateMinDate(object, property, value) {
  if (!value) return;
  if (!object[property] || value < object[property]) {
    object[property] = value;
  }
}

function updateMaxDate(object, property, value) {
  if (!value) return;
  if (!object[property] || value > object[property]) {
    object[property] = value;
  }
}

function sortByTitle(items) {
  return [...items].sort((left, right) => left.title.localeCompare(right.title, 'en', { sensitivity: 'base' }));
}

function makeTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '--:--:--';
  }

  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

class Progress {
  constructor(total, intervalMs) {
    this.total = Math.max(1, total);
    this.intervalMs = intervalMs;
    this.done = 0;
    this.startedAt = Date.now();
    this.lastPrintedAt = 0;
    this.lastPrintedDone = 0;
  }

  tick(amount, phase) {
    this.done += amount;
    const enoughRecords = this.intervalMs === 0 ? false : this.done - this.lastPrintedDone >= 500;
    this.status(phase, enoughRecords);
  }

  status(phase, force = false) {
    const now = Date.now();
    if (!force && this.intervalMs === 0) return;
    if (!force && this.intervalMs > 0 && now - this.lastPrintedAt < this.intervalMs) return;

    const elapsed = now - this.startedAt;
    const remaining = Math.max(0, this.total - this.done);
    const eta = this.done > 0 ? (elapsed / this.done) * remaining : NaN;
    const percent = Math.min(100, (this.done / this.total) * 100).toFixed(1);

    console.log(`[status] phase=${phase} | elapsed=${formatDuration(elapsed)} | eta~=${formatDuration(eta)} | remaining=${remaining}/${this.total} | ${percent}%`);

    this.lastPrintedAt = now;
    this.lastPrintedDone = this.done;
  }
}

class ZipArchive {
  constructor(buffer, entries) {
    this.buffer = buffer;
    this.entries = entries;
  }

  static fromFile(filePath) {
    const buffer = fs.readFileSync(filePath);
    return new ZipArchive(buffer, readCentralDirectory(buffer));
  }

  static fromBuffer(buffer) {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    return new ZipArchive(data, readCentralDirectory(data));
  }

  getEntry(name) {
    return this.entries.get(name);
  }

  readText(name) {
    const entry = this.getEntry(name);
    if (!entry) {
      throw new Error(`ZIP entry not found: ${name}`);
    }
    return this.readBuffer(entry).toString('utf8');
  }

  readBuffer(entry) {
    const offset = entry.localHeaderOffset;
    if (this.buffer.readUInt32LE(offset) !== 0x04034b50) {
      throw new Error(`Invalid local ZIP header for ${entry.name}`);
    }

    const fileNameLength = this.buffer.readUInt16LE(offset + 26);
    const extraLength = this.buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + fileNameLength + extraLength;
    const compressed = this.buffer.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.method === 0) return compressed;
    if (entry.method === 8) return zlib.inflateRawSync(compressed);
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  }
}

function readCentralDirectory(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    entries.set(name, { name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('Invalid ZIP file: end of central directory not found');
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = toDosDateTime(new Date());

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralOffset = offset;
  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, end]);
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

let CRC_TABLE = null;

function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = makeCrcTable();
  }

  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

module.exports = {
  APP_NAME,
  DEFAULT_INPUT,
  DEFAULT_OUTPUT_DIR,
  SIMKL_INTERNAL_JSON_NAME,
  main,
  parseArgs,
  printHelp,
  loadTvTimeData,
  estimateWork,
  convertTvTimeToSimklJson,
  renderReportCsv,
  renderReportMarkdown,
  printSummaryTable,
  makeTimestamp,
  formatDuration,
  Progress,
  ZipArchive,
  createZip,
};
