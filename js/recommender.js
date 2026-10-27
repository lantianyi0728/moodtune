/**
 * recommender.js —— 基于情绪的音乐推荐算法
 * ============================================================
 * 核心思想：把「情绪」和「歌曲」放在同一个二维情感空间里
 *   valence（效价，0=消极 1=积极）
 *   arousal（唤醒度，0=平静 1=激烈）
 * 情绪决定目标坐标与目标 BPM，歌曲按元数据计算匹配度。
 *
 * 评分公式（总分 1.0）：
 *   S = 0.40 · TagSim        情绪标签相似度
 *     + 0.25 · BpmFit         节奏贴合度
 *     + 0.20 · ValenceFit     效价贴合度
 *     + 0.15 · ArousalFit     唤醒度贴合度
 *     ─ Penalty               重复惩罚（最近播过 / 同艺人扎堆）
 *     + Bonus                 探索加分（新曲目）
 *
 * 排序后再做一次 MMR 多样性重排，避免前几首高度同质。
 * ============================================================
 */
(function (global) {
  'use strict';

  /** 每种情绪的音乐画像：理想 BPM 区间、目标情感坐标、在线搜索关键词 */
  const EMOTION_PROFILE = {
    happy: {
      cn: '开心', bpmRange: [108, 134], valence: 0.90, arousal: 0.78,
      genres: ['Pop', 'Dance', 'Funk'],
      queries: ['happy upbeat pop', '开心 欢快 流行', 'feel good music'],
      tip: '用明亮、节奏轻快的音乐把好心情延续下去',
    },
    sad: {
      cn: '悲伤', bpmRange: [56, 82], valence: 0.18, arousal: 0.30,
      genres: ['Piano', 'Acoustic', 'Ambient'],
      queries: ['sad piano emotional', '伤感 钢琴 慢歌', 'melancholy acoustic'],
      tip: '先用慢速低亮度的音乐共情，帮助你释放情绪',
    },
    angry: {
      cn: '愤怒', bpmRange: [132, 165], valence: 0.24, arousal: 0.92,
      genres: ['Rock', 'Metal', 'Hip-Hop'],
      queries: ['aggressive rock heavy', '愤怒 摇滚 燃', 'hard rock intense'],
      tip: '高唤醒度的强烈节奏可以给情绪一个出口',
    },
    fearful: {
      cn: '恐惧', bpmRange: [68, 96], valence: 0.20, arousal: 0.62,
      genres: ['Ambient', 'Cinematic', 'Dark'],
      queries: ['calm soothing ambient', '安静 治愈 舒缓', 'soothing piano'],
      tip: '用稳定、可预测的低唤醒音乐降低紧张感',
    },
    disgusted: {
      cn: '厌恶', bpmRange: [92, 120], valence: 0.26, arousal: 0.58,
      genres: ['Experimental', 'Electronic', 'Industrial'],
      queries: ['dark experimental electronic', '另类 电子 冷感', 'industrial beat'],
      tip: '用略带张力的冷色调音乐给情绪留出距离',
    },
    surprised: {
      cn: '惊讶', bpmRange: [118, 142], valence: 0.68, arousal: 0.88,
      genres: ['Electronic', 'Pop', 'Future Bass'],
      queries: ['energetic electronic', '电子 燃 节奏', 'future bass drop'],
      tip: '用高能量电子乐把瞬间的冲击感接住',
    },
    neutral: {
      cn: '平静', bpmRange: [76, 100], valence: 0.52, arousal: 0.38,
      genres: ['Lo-Fi', 'Ambient', 'Jazz'],
      queries: ['chill lofi instrumental', '轻音乐 白噪音', 'lofi study beats'],
      tip: '保持现状，用不抢戏的背景音乐陪伴当下',
    },
  };

  /**
   * 情绪标签相似度矩阵（行=用户情绪，列=歌曲标签）
   * 1.0 = 完全匹配；数值来自心理学上情绪维度的邻近关系
   */
  const TAG_SIM = {
    happy:     { happy: 1.00, surprised: 0.62, romantic: 0.58, neutral: 0.40, focused: 0.30, sad: 0.12, angry: 0.10, fearful: 0.10, disgusted: 0.08 },
    sad:       { sad: 1.00, fearful: 0.56, romantic: 0.52, neutral: 0.44, focused: 0.34, angry: 0.18, surprised: 0.10, happy: 0.10, disgusted: 0.12 },
    angry:     { angry: 1.00, disgusted: 0.66, surprised: 0.34, fearful: 0.32, happy: 0.10, sad: 0.16, neutral: 0.12, romantic: 0.08, focused: 0.10 },
    fearful:   { fearful: 1.00, sad: 0.54, surprised: 0.46, angry: 0.32, neutral: 0.36, focused: 0.30, romantic: 0.22, happy: 0.10, disgusted: 0.24 },
    disgusted: { disgusted: 1.00, angry: 0.62, sad: 0.36, fearful: 0.26, neutral: 0.24, surprised: 0.20, happy: 0.10, romantic: 0.08, focused: 0.14 },
    surprised: { surprised: 1.00, happy: 0.62, fearful: 0.46, angry: 0.32, neutral: 0.26, romantic: 0.20, sad: 0.10, disgusted: 0.18, focused: 0.16 },
    neutral:   { neutral: 1.00, focused: 0.82, romantic: 0.46, happy: 0.40, sad: 0.44, fearful: 0.36, surprised: 0.26, angry: 0.12, disgusted: 0.14 },
  };

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  /** 取标签相似度，缺失时给一个保守的小值 */
  function tagSim(userEmotion, songEmotion) {
    const row = TAG_SIM[userEmotion];
    if (!row) return 0.2;
    const v = row[songEmotion];
    return typeof v === 'number' ? v : 0.12;
  }

  /** 节奏贴合度：距目标区间的中心越近越高 */
  function bpmFit(songBpm, range) {
    if (!songBpm || !range) return 0.5;
    const center = (range[0] + range[1]) / 2;
    const half = (range[1] - range[0]) / 2;
    const d = Math.abs(songBpm - center);
    return clamp01(1 - Math.max(0, d - half) / 55);  // 区间内满分，越远衰减越快
  }

  /**
   * 给单首歌打分
   * @returns {{score:number, parts:object, reasons:string[]}}
   */
  function scoreSong(song, emotion, profile, ctx) {
    ctx = ctx || {};
    // 情绪标签相似度：
    //   本地曲目用人工标注的 emotion 标签查相似度矩阵；
    //   在线曲目的 emotion 是按搜索词赋的，全部相同会失去区分度，
    //   因此改用「搜索相关性排名」作为标签相似度（搜得越靠前越贴题）。
    let tag;
    if (song.searchRank != null) {
      tag = Math.max(0.55, 0.88 - song.searchRank * 0.025);
    } else if (song.emotion) {
      tag = tagSim(emotion, song.emotion);
    } else {
      tag = 0.75;
    }
    const bpm = bpmFit(song.bpm, profile.bpmRange);
    const val = clamp01(1 - Math.abs((song.valence != null ? song.valence : profile.valence) - profile.valence));
    const aro = clamp01(1 - Math.abs((song.arousal != null ? song.arousal : profile.arousal) - profile.arousal));

    let score = 0.40 * tag + 0.25 * bpm + 0.20 * val + 0.15 * aro;

    // --- 惩罚：最近播放过 ---
    let penalty = 0;
    const hist = ctx.history || [];
    const idx = hist.indexOf(song.id);
    if (idx >= 0) {
      const recency = hist.length - idx;                 // 1 = 刚刚播过
      penalty += 0.40 * clamp01(1 - (recency - 1) / 6);
    }
    // --- 惩罚：同艺人扎堆 ---
    const sameArtist = (ctx.recentArtists || []).filter((a) => a === song.artist).length;
    if (sameArtist > 0) penalty += 0.06 * Math.min(2, sameArtist);

    // --- 探索加分：曲库中没播过的歌更容易被选中 ---
    const played = ctx.playedIds || [];
    const bonus = played.indexOf(song.id) >= 0 ? 0 : 0.03;

    score = Math.max(0, Math.min(1, score - penalty + bonus));

    // 在线曲目缺少真实 BPM/情感元数据，用情绪画像做先验估计，打折表示不确定性
    if (song.estimated) score *= 0.90;

    // --- 生成可解释理由 ---
    const reasons = [];
    if (song.searchRank != null) {
      reasons.push(`按情绪关键词搜索的相关性排名第 ${song.searchRank + 1} 位`);
    } else if (tag >= 0.99) {
      reasons.push(`情绪标签完全命中「${profile.cn}」`);
    } else if (tag >= 0.5) {
      reasons.push(`情绪标签「${song.emotion || '未知'}」与当前情绪相近（${(tag * 100).toFixed(0)}%）`);
    }
    if (bpm >= 0.9) reasons.push(`节奏 ${song.bpm || '—'} BPM 落在${profile.cn}的理想区间 ${profile.bpmRange[0]}–${profile.bpmRange[1]}`);
    else if (bpm <= 0.4) reasons.push(`节奏偏${{ happy: '慢', sad: '快', angry: '慢' }[emotion] || '离'}目标区`);
    if (val >= 0.85) reasons.push(`亮度 ${((song.valence != null ? song.valence : 0.5)).toFixed(2)} 匹配当前情绪基调`);
    if (aro >= 0.85) reasons.push(`能量 ${((song.arousal != null ? song.arousal : 0.5)).toFixed(2)} 贴合当前唤醒水平`);
    if (idx >= 0) reasons.push('最近播放过，已自动降权');
    if (song.estimated) reasons.push('在线曲目，节奏与情感为按情绪画像的估算值（评分已打折）');
    if (!reasons.length) reasons.push('综合特征匹配度可接受');

    return { score, parts: { tag, bpm, val, aro, penalty, bonus }, reasons };
  }

  /** 两首歌的相似度（用于 MMR 多样性重排） */
  function songSimilarity(a, b) {
    const bpmD = Math.abs((a.bpm || 100) - (b.bpm || 100)) / 70;
    const valD = Math.abs((a.valence != null ? a.valence : 0.5) - (b.valence != null ? b.valence : 0.5));
    const aroD = Math.abs((a.arousal != null ? a.arousal : 0.5) - (b.arousal != null ? b.arousal : 0.5));
    return clamp01(0.45 * bpmD + 0.3 * valD + 0.25 * aroD);
  }

  /**
   * 主入口：给出情绪 → 返回排序后的推荐列表
   * @param {Array} songs  候选歌曲
   * @param {string} emotion 用户情绪
   * @param {object} opts { history, playedIds, limit, lambda }
   */
  function recommend(songs, emotion, opts) {
    opts = opts || {};
    const profile = EMOTION_PROFILE[emotion] || EMOTION_PROFILE.neutral;
    const limit = opts.limit || 10;
    const lambda = opts.lambda != null ? opts.lambda : 0.28;
    const ctx = {
      history: opts.history || [],
      recentArtists: (opts.history || []).slice(-2).map((id) => {
        const s = songs.find((x) => x.id === id);
        return s ? s.artist : '';
      }),
      playedIds: opts.playedIds || [],
    };

    const scored = songs
      .map((s) => {
        const r = scoreSong(s, emotion, profile, ctx);
        return Object.assign({}, s, { score: r.score, parts: r.parts, reasons: r.reasons });
      })
      .sort((a, b) => b.score - a.score);

    // --- MMR 多样性重排：在「高分」与「不重复」之间平衡 ---
    const selected = [];
    const pool = scored.slice();
    while (selected.length < Math.min(limit, scored.length) && pool.length) {
      let bestIdx = 0;
      let bestVal = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        let maxSim = 0;
        for (const s of selected) maxSim = Math.max(maxSim, songSimilarity(pool[i], s));
        const val = pool[i].score - lambda * maxSim;
        if (val > bestVal) { bestVal = val; bestIdx = i; }
      }
      selected.push(pool.splice(bestIdx, 1)[0]);
    }
    return selected;
  }

  global.Recommender = {
    EMOTION_PROFILE,
    TAG_SIM,
    recommend,
    scoreSong,
    tagSim,
    bpmFit,
  };
})(window);
