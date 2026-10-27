/**
 * music-service.js —— 曲源聚合服务
 * ============================================================
 * 两种曲源统一成同一个 Song 结构，交给推荐算法打分：
 *
 *   1. 本地曲库  data/songs.json + audio/*.mp3
 *      完整曲目、带人工标注的 BPM / valence / arousal 元数据，离线可用。
 *
 *   2. 在线接口  iTunes Search API + Audius API
 *      iTunes：全球曲库元数据 + 30 秒官方试听片段（m4a）
 *      Audius：独立音乐人平台，可直接播放完整曲目
 *      两者都返回 Access-Control-Allow-Origin: *，浏览器可直连，无需后端代理。
 *
 * 在线曲目缺少 BPM/情感维度数据，因此用当前情绪的画像值作为先验估计，
 * 并标记 estimated = true，评分时会被打折（不确定性折扣）。
 * ============================================================
 */
(function (global) {
  'use strict';

  const AUDIUS_APP = 'emotion-music-demo';
  const AUDIUS_API = 'https://api.audius.co/v1';
  const ITUNES_API = 'https://itunes.apple.com/search';

  /** 带超时的 fetch + JSON */
  async function fetchJSON(url, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout || 12000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** iTunes 的 100x100 封面地址可以替换成更大尺寸 */
  function upscaleArtwork(url, size) {
    if (!url) return null;
    return url.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${size}x${size}bb.$1`);
  }

  // ---------------------------------------------------------
  // 本地曲库
  // ---------------------------------------------------------
  async function loadLocalSongs() {
    const r = await fetch('data/songs.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('本地曲库读取失败 HTTP ' + r.status);
    const list = await r.json();
    return list.map((s) => Object.assign({}, s, {
      source: 'local',
      src: s.file,
      online: false,
    }));
  }

  // ---------------------------------------------------------
  // iTunes Search API
  // ---------------------------------------------------------
  async function searchItunes(query, limit) {
    const url = `${ITUNES_API}?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit || 12}&country=CN`;
    const data = await fetchJSON(url, 12000);
    const results = (data && data.results) || [];
    return results
      .filter((t) => t.previewUrl)
      .map((t, rank) => ({
        id: 'itunes-' + t.trackId,
        title: t.trackName,
        artist: t.artistName,
        album: t.collectionName,
        cover: upscaleArtwork(t.artworkUrl100, 300),
        src: t.previewUrl,
        duration: Math.round((t.trackTimeMillis || 30000) / 1000),
        previewSeconds: 30,
        genre: t.primaryGenreName,
        source: 'iTunes',
        sourceUrl: t.trackViewUrl,
        online: true,
        searchRank: rank,
      }));
  }

  // ---------------------------------------------------------
  // Audius API
  // ---------------------------------------------------------
  async function searchAudius(query, limit) {
    const url = `${AUDIUS_API}/tracks/search?query=${encodeURIComponent(query)}&limit=${limit || 10}&app_name=${AUDIUS_APP}`;
    const data = await fetchJSON(url, 12000);
    const tracks = (data && data.data) || [];
    return tracks
      .filter((t) => !t.is_delete && t.duration > 20)
      .map((t, rank) => ({
        id: 'audius-' + t.id,
        title: t.title,
        artist: (t.user && t.user.name) || 'Unknown',
        cover: t.artwork ? t.artwork['480x480'] || t.artwork['150x150'] : null,
        src: `${AUDIUS_API}/tracks/${t.id}/stream?app_name=${AUDIUS_APP}`,
        duration: t.duration,
        genre: t.genre,
        mood: t.mood,
        source: 'Audius',
        sourceUrl: t.permalink ? 'https://audius.co' + t.permalink : 'https://audius.co',
        online: true,
        searchRank: rank,
      }));
  }

  /**
   * 按情绪搜索在线曲目（iTunes + Audius 并行，任何一个挂掉都不影响另一个）
   * @param {string} emotion
   * @param {object} profile 情绪画像（含 queries）
   * @param {object} opts { limit }
   * @returns {Promise<{songs:Array, errors:Array}>}
   */
  async function searchOnline(emotion, profile, opts) {
    opts = opts || {};
    if (!navigator.onLine) return { songs: [], errors: ['当前离线'] };

    const queries = (profile && profile.queries) || [emotion];
    const perSource = opts.limit || 10;

    const tasks = [];
    queries.slice(0, 2).forEach((q, i) => {
      tasks.push(
        searchItunes(q, perSource).then((s) => ({ ok: true, src: 'iTunes', songs: s }))
          .catch((e) => ({ ok: false, src: 'iTunes', err: String(e.message || e) }))
      );
      if (i === 0) {
        tasks.push(
          searchAudius(q, perSource).then((s) => ({ ok: true, src: 'Audius', songs: s }))
            .catch((e) => ({ ok: false, src: 'Audius', err: String(e.message || e) }))
        );
      }
    });

    const settled = await Promise.all(tasks);
    const errors = [];
    let songs = [];
    for (const r of settled) {
      if (r.ok) songs = songs.concat(r.songs);
      else errors.push(`${r.src}: ${r.err}`);
    }

    // 去重：同名同艺人只保留一条
    const seen = new Set();
    songs = songs.filter((s) => {
      const k = (s.title || '').toLowerCase().replace(/\s+/g, '') + '|' + (s.artist || '').toLowerCase().replace(/\s+/g, '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // 用情绪画像给在线曲目补上估算的情感坐标与 BPM
    songs = songs.map((s) => Object.assign({}, s, {
      emotion: emotion,
      valence: profile.valence,
      arousal: profile.arousal,
      bpm: Math.round((profile.bpmRange[0] + profile.bpmRange[1]) / 2),
      estimated: true,
    }));

    return { songs, errors };
  }

  global.MusicService = {
    AUDIUS_APP,
    loadLocalSongs,
    searchItunes,
    searchAudius,
    searchOnline,
  };
})(window);
