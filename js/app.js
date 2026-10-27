/**
 * app.js —— MoodTune 情绪电台 主应用（Vue 3）
 * ============================================================
 * 职责：
 *   1. 管理四种画面输入源（摄像头 / 本地图片 / 本地视频 / 拍照定格）
 *   2. 驱动情绪引擎循环识别，并绘制人脸框
 *   3. 情绪稳定后自动调用推荐算法刷新歌单
 *   4. 播放器：本地曲目完整播放 + 在线曲目流式播放
 * ============================================================
 */
(function () {
  'use strict';

  const { createApp, ref, computed, nextTick, onMounted, onBeforeUnmount } = Vue;
  const META = window.EMOTION_META;
  const KEYS = window.EMOTION_KEYS;
  const Engine = window.EmotionEngine;
  const Rec = window.Recommender;
  const Music = window.MusicService;

  /** 检测间隔：给浏览器留出渲染余量，约 4-5 次/秒足够情绪判定 */
  const DETECT_INTERVAL = 200;
  /** 情绪变化后等待多久再刷新推荐，避免识别过程抖动导致频繁切歌单 */
  const RECO_DELAY = 900;

  createApp({
    setup() {
      /* ---------------------------------------------------- 基础状态 */
      const engine = ref(null);
      const modelReady = ref(false);
      const loadingText = ref('准备中…');
      const toastMsg = ref('');
      let toastTimer = null;
      const bootError = ref(null);   // 启动前置条件不满足时的全屏引导

      const sourceTabs = [
        { key: 'camera', label: '摄像头', icon: '◉' },
        { key: 'photo', label: '图片', icon: '▣' },
        { key: 'video', label: '视频', icon: '▷' },
      ];
      // 拍照属于摄像头的附属动作，不单独占 tab
      const sourceType = ref('camera');
      const isRunning = ref(false);
      const faceDetected = ref(false);
      const fps = ref(0);
      const detectMs = ref(0);

      const videoEl = ref(null);
      const photoEl = ref(null);
      const overlayEl = ref(null);
      const audioEl = ref(null);

      const photoDataUrl = ref('');
      const videoLoaded = ref(false);
      const videoPaused = ref(true);
      const stageRatio = ref('4 / 3');

      /* ---------------------------------------------------- 识别结果 */
      const lastResult = ref(null);
      const mainEmotion = ref('neutral');
      const probs = ref(KEYS.reduce((o, k) => ((o[k] = 0), o), {}));

      /* ---------------------------------------------------- 曲库与推荐 */
      const localSongs = ref([]);
      const onlineSongs = ref([]);
      const recommendations = ref([]);
      const includeOnline = ref(true);
      const loadingRec = ref(false);
      const onlineErrors = ref([]);
      const history = ref([]);      // 播放过的 id（最近的在后）
      const playedIds = ref([]);    // 本次会话所有播放过的 id
      let lastRecoEmotion = null;
      let pendingRecoEmotion = null;   // 正在等待刷新的情绪（避免每帧重置计时器）
      let recoTimer = null;
      let recSeq = 0;               // 请求序号，防止旧请求覆盖新结果

      /* ---------------------------------------------------- 播放器 */
      const current = ref(null);
      const isPlaying = ref(false);
      const progress = ref(0);
      const duration = ref(0);
      const volume = ref(0.75);
      const muted = ref(false);

      /* ==================================================== 工具函数 */
      function toast(msg) {
        toastMsg.value = msg;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (toastMsg.value = ''), 2800);
      }
      const meta = (k) => META[k] || META.neutral;
      const profile = (k) => Rec.EMOTION_PROFILE[k] || Rec.EMOTION_PROFILE.neutral;
      const pct = (v) => ((v || 0) * 100).toFixed(0) + '%';
      const fmtTime = (s) => {
        if (!s || !isFinite(s)) return '0:00';
        const m = Math.floor(s / 60);
        const ss = Math.floor(s % 60);
        return m + ':' + String(ss).padStart(2, '0');
      };
      const cssVars = computed(() => ({ '--accent': meta(mainEmotion.value).color }));

      const hasFrame = computed(() => {
        if (sourceType.value === 'camera') return isRunning.value;
        if (sourceType.value === 'photo') return !!photoDataUrl.value;
        return videoLoaded.value;
      });
      const stageLabel = computed(() => {
        if (sourceType.value === 'camera') return 'LIVE 摄像头';
        if (sourceType.value === 'photo') return '静态图片';
        return '本地视频';
      });
      const emptyHint = computed(() => {
        if (sourceType.value === 'camera') {
          if (!window.isSecureContext) {
            return '当前不是安全上下文，摄像头无法使用。请用 localhost 打开（见 README 的启动方式）。';
          }
          return '点击下方「启动摄像头」开始识别，画面只在本地推理，不会上传。';
        }
        if (sourceType.value === 'photo') return '选择一张含有人脸的图片，系统会在本地识别情绪。';
        return '打开一个本地视频文件，播放过程中会持续分析人脸情绪。';
      });
      const stableRatio = computed(() =>
        lastResult.value ? lastResult.value.confidence : 0
      );
      const detail = computed(() => {
        const r = lastResult.value;
        const w = (r && r.weights) || { cnn: 0.75, geo: 0.25 };
        const f = (r && r.features) || {
          mouthCurve: 0, mouthOpen: 0, browSlant: 0, browRaise: 0, ear: 0, upperLipRaise: 0,
        };
        return { wCnn: w.cnn, wGeo: w.geo, f };
      });
      const smoothingWindow = ref(14);

      const progressPct = computed(() =>
        duration.value > 0 ? Math.min(100, (progress.value / duration.value) * 100) : 0
      );
      function coverBg(s) {
        const c = (s && s.color) || meta(s && s.emotion).color;
        return `linear-gradient(135deg, ${c}44, ${c}18)`;
      }
      function onCoverError(s) { s.cover = null; }

      /* ==================================================== 人脸框绘制 */
      function drawOverlay(box, el) {
        const cv = overlayEl.value;
        if (!cv) return;
        const w = (el && (el.videoWidth || el.naturalWidth)) || el.clientWidth || 1;
        const h = (el && (el.videoHeight || el.naturalHeight)) || el.clientHeight || 1;
        if (cv.width !== w) cv.width = w;
        if (cv.height !== h) cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cv.width, cv.height);
        if (!box) return;

        const color = meta(mainEmotion.value).color;
        const lw = Math.max(2, w * 0.0035);

        // 检测框本身偏宽松，稍微内缩一点视觉上更贴合人脸
        const pad = 0.07;
        const x = box.x + box.width * pad;
        const y = box.y + box.height * pad;
        const bw = box.width * (1 - pad * 2);
        const bh = box.height * (1 - pad * 2);
        const len = Math.min(bw, bh) * 0.24;

        // 先画一圈淡色细边（暗示完整范围），再叠四个角标
        ctx.save();
        ctx.globalAlpha = 0.32;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, lw * 0.5);
        ctx.strokeRect(x, y, bw, bh);
        ctx.restore();

        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;

        const corners = [
          [x, y, 1, 1], [x + bw, y, -1, 1],
          [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1],
        ];
        for (const [cx, cy, sx, sy] of corners) {
          ctx.beginPath();
          ctx.moveTo(cx + sx * len, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + sy * len);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }

      /* ==================================================== 识别循环 */
      let loopTimer = null;
      let detectBusy = false;
      let stampList = [];

      function currentInput() {
        if (sourceType.value === 'photo') return photoEl.value;
        return videoEl.value;
      }

      function processResult(res) {
        if (!res) {
          faceDetected.value = false;
          drawOverlay(null, currentInput());
          // 连续无脸时清空概率，避免旧情绪残留
          return;
        }
        faceDetected.value = true;
        lastResult.value = res;
        mainEmotion.value = res.emotion;
        probs.value = res.probs;
        drawOverlay(res.box, currentInput());
        scheduleReco(res.emotion);
      }

      function tickFps(costMs) {
        detectMs.value = Math.round(costMs);
        const now = performance.now();
        stampList.push(now);
        while (stampList.length > 12) stampList.shift();
        if (stampList.length > 2) {
          const dt = stampList[stampList.length - 1] - stampList[0];
          fps.value = ((stampList.length - 1) / dt) * 1000;
        }
      }

      async function loop() {
        if (!isRunning.value || !engine.value) return;
        const input = currentInput();
        if (!input) {
          loopTimer = setTimeout(loop, 300);
          return;
        }
        // 视频/图片还没准备好就等一下，别硬推理
        const ready =
          sourceType.value === 'photo'
            ? input.complete && input.naturalWidth > 0
            : input.readyState >= 2;
        if (!ready) {
          loopTimer = setTimeout(loop, 200);
          return;
        }
        if (detectBusy) {
          loopTimer = setTimeout(loop, DETECT_INTERVAL);
          return;
        }
        detectBusy = true;
        const t0 = performance.now();
        try {
          const res = await engine.value.detect(input, {
            inputSize: sourceType.value === 'photo' ? 448 : 320,
          });
          tickFps(performance.now() - t0);
          processResult(res);
        } catch (err) {
          console.warn('[detect]', err);
        } finally {
          detectBusy = false;
          if (isRunning.value) {
            // 静态图片不会变化，低频复检即可；摄像头/视频才需要实时跟随
            const gap = sourceType.value === 'photo' ? 1500 : DETECT_INTERVAL;
            loopTimer = setTimeout(loop, gap);
          }
        }
      }

      function startLoop() {
        stopLoop();
        isRunning.value = true;
        stampList = [];
        loop();
      }
      function stopLoop() {
        isRunning.value = false;
        if (loopTimer) clearTimeout(loopTimer);
        loopTimer = null;
        drawOverlay(null, currentInput());
      }

      /* ==================================================== 输入源：摄像头 */
      let mediaStream = null;

      async function startCamera() {
        if (!modelReady.value) {
          toast('模型还在加载，稍等一下');
          return;
        }
        if (!window.isSecureContext) {
          toast('摄像头需要 localhost 或 https 环境，请用启动脚本打开');
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          toast('当前浏览器不支持摄像头采集');
          return;
        }
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
            audio: false,
          });
          sourceType.value = 'camera';
          photoDataUrl.value = '';
          const v = videoEl.value;
          v.srcObject = mediaStream;
          await v.play();
          stageRatio.value = `${v.videoWidth || 1280} / ${v.videoHeight || 720}`;
          engine.value.reset();
          startLoop();
        } catch (err) {
          const name = err && err.name;
          if (name === 'NotAllowedError') toast('摄像头权限被拒绝，请在地址栏允许后重试');
          else if (name === 'NotFoundError') toast('没有找到可用的摄像头设备');
          else toast('摄像头打开失败：' + (err.message || name));
        }
      }

      function stopCameraStream() {
        if (mediaStream) {
          mediaStream.getTracks().forEach((t) => t.stop());
          mediaStream = null;
        }
        if (videoEl.value) videoEl.value.srcObject = null;
      }

      function stopAll() {
        stopLoop();
        stopCameraStream();
        if (videoEl.value && sourceType.value === 'video') videoEl.value.pause();
        videoPaused.value = true;
        engine.value && engine.value.reset();
        lastResult.value = null;
        faceDetected.value = false;
        probs.value = KEYS.reduce((o, k) => ((o[k] = 0), o), {});
        drawOverlay(null, currentInput());
      }

      /* ==================================================== 输入源：拍照 */
      async function takePhoto() {
        const v = videoEl.value;
        if (!v || !v.videoWidth) { toast('摄像头还没准备好'); return; }
        const cv = document.createElement('canvas');
        cv.width = v.videoWidth;
        cv.height = v.videoHeight;
        const ctx = cv.getContext('2d');
        // 摄像头画面是镜像显示的，拍照时翻回来，得到真实朝向的照片
        ctx.translate(cv.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(v, 0, 0, cv.width, cv.height);
        photoDataUrl.value = cv.toDataURL('image/jpeg', 0.92);
        stageRatio.value = `${cv.width} / ${cv.height}`;

        stopLoop();
        stopCameraStream();
        sourceType.value = 'photo';
        engine.value.reset();

        await nextTick();
        const img = photoEl.value;
        const run = () => {
          engine.value.reset();
          startLoop();
        };
        if (!img) run();
        else if (img.complete) run();
        else img.onload = run;
      }

      /* ==================================================== 输入源：图片 */
      function onPickImage(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
        stopCameraStream();
        stopLoop();
        const reader = new FileReader();
        reader.onload = async () => {
          photoDataUrl.value = reader.result;
          sourceType.value = 'photo';
          engine.value.reset();
          await nextTick();
          const img = photoEl.value;
          if (!img) { engine.value.reset(); startLoop(); return; }
          const go = () => {
            stageRatio.value = `${img.naturalWidth} / ${img.naturalHeight}`;
            engine.value.reset();
            startLoop();
          };
          if (img.complete && img.naturalWidth) go();
          else img.onload = go;
        };
        reader.readAsDataURL(file);
        e.target.value = '';
      }

      async function detectOnce() {
        if (!photoDataUrl.value) return;
        const img = photoEl.value;
        if (!img || !img.naturalWidth) return;
        try {
          const res = await engine.value.detect(img, { inputSize: 512, smooth: false });
          engine.value.reset();
          processResult(res);
          if (!res) toast('这张图片里没有检测到人脸');
        } catch (err) {
          toast('识别失败：' + (err.message || err));
        }
      }

      /* ==================================================== 输入源：视频 */
      function onPickVideo(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('video/')) { toast('请选择视频文件'); return; }
        stopCameraStream();
        stopLoop();
        sourceType.value = 'video';
        const url = URL.createObjectURL(file);
        const v = videoEl.value;
        v.srcObject = null;
        v.src = url;
        v.loop = false;
        v.muted = false;
        videoLoaded.value = true;
        v.onloadedmetadata = async () => {
          stageRatio.value = `${v.videoWidth || 16} / ${v.videoHeight || 9}`;
          engine.value.reset();
          try { await v.play(); videoPaused.value = false; } catch (err) {}
          startLoop();
        };
        e.target.value = '';
      }

      function toggleVideoPlay() {
        const v = videoEl.value;
        if (!v.src) return;
        if (v.paused) { v.play(); videoPaused.value = false; }
        else { v.pause(); videoPaused.value = true; }
      }

      function switchSource(key) {
        if (key === 'camera') {
          stopAll();
          videoLoaded.value = false;
          sourceType.value = 'camera';
          return;
        }
        if (key === 'photo') {
          stopAll();
          videoLoaded.value = false;
          sourceType.value = 'photo';
          if (photoDataUrl.value) {
            nextTick(() => {
              if (engine.value) { engine.value.reset(); startLoop(); }
            });
          }
          return;
        }
        if (key === 'video') {
          stopAll();
          sourceType.value = 'video';
        }
      }

      /* ==================================================== 推荐 */
      function scheduleReco(emotion) {
        // 关键：检测循环每帧都会调到这里。若不记住"已在排队"，
        // 每帧都会 clearTimeout 重启计时器，导致永远等不到 900ms。
        if (emotion === lastRecoEmotion) return;
        if (emotion === pendingRecoEmotion) return;
        pendingRecoEmotion = emotion;
        clearTimeout(recoTimer);
        recoTimer = setTimeout(() => {
          pendingRecoEmotion = null;
          if (mainEmotion.value === emotion) refreshRecommendations(false);
        }, RECO_DELAY);
      }

      async function refreshRecommendations(force) {
        const emo = mainEmotion.value;
        if (!force && emo === lastRecoEmotion) return;
        const seq = ++recSeq;
        onlineErrors.value = [];

        const recOpts = {
          history: history.value.slice(-8),
          playedIds: playedIds.value,
          limit: 12,
        };

        // 第一步：本地曲库立刻出结果，界面马上有内容（在线接口慢也不影响观感）
        recommendations.value = Rec.recommend(localSongs.value.slice(), emo, recOpts);

        if (!includeOnline.value) {
          lastRecoEmotion = emo;
          loadingRec.value = false;
          return;
        }

        // 第二步：异步拉在线曲库，回来后合并重排
        loadingRec.value = recommendations.value.length === 0;
        try {
          const { songs, errors } = await Music.searchOnline(emo, profile(emo), { limit: 10 });
          if (seq !== recSeq) return;      // 已有更新的请求，丢弃本次
          onlineSongs.value = songs;
          onlineErrors.value = errors;
          if (songs.length) {
            // 合并前按「歌名 + 艺人」去重：同一首歌可能本地和在线都存在，
            // 此时保留本地版本（完整曲目，元数据更准）
            const key = (s) => (s.title || '').toLowerCase().replace(/\s+/g, '') + '|' +
                               (s.artist || '').toLowerCase().replace(/\s+/g, '');
            const seen = new Set(localSongs.value.map(key));
            const extra = songs.filter((s) => {
              const k = key(s);
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            const merged = localSongs.value.concat(extra);
            recommendations.value = Rec.recommend(merged, emo, recOpts);
          }
        } catch (err) {
          if (seq === recSeq) onlineErrors.value = ['在线曲库连接失败：' + (err.message || err)];
        } finally {
          if (seq === recSeq) loadingRec.value = false;
        }
        lastRecoEmotion = emo;
      }

      /* ==================================================== 播放器 */
      async function playSong(song, index) {
        if (!song) return;
        current.value = song;
        history.value.push(song.id);
        if (!playedIds.value.includes(song.id)) playedIds.value.push(song.id);

        await nextTick();
        const a = audioEl.value;
        if (!a) return;
        a.src = song.src;
        a.volume = muted.value ? 0 : volume.value;
        try {
          await a.play();
        } catch (err) {
          toast('这首歌无法播放：' + (err.message || err) + (song.online ? '（在线源可能限流，换一首试试）' : ''));
        }
        // 若当前推荐列表已过期，情绪变化后再刷新时保持播放不中断
      }

      function togglePlay() {
        const a = audioEl.value;
        if (!a || !current.value) return;
        if (a.paused) a.play().catch(() => {});
        else a.pause();
      }

      function stepSong(delta) {
        const list = recommendations.value;
        if (!list.length) return;
        const idx = current.value ? list.findIndex((s) => s.id === current.value.id) : -1;
        let next = idx + delta;
        if (next < 0) next = list.length - 1;
        if (next >= list.length) next = 0;
        playSong(list[next], next);
      }
      const nextSong = () => stepSong(1);
      const prevSong = () => stepSong(-1);

      function onTimeUpdate() {
        const a = audioEl.value;
        if (!a) return;
        progress.value = a.currentTime || 0;
      }
      function onMeta() {
        const a = audioEl.value;
        if (!a) return;
        duration.value = isFinite(a.duration) ? a.duration : current.value ? current.value.duration : 0;
      }
      function onEnded() {
        isPlaying.value = false;
        nextSong();
      }
      function seek(ev) {
        const a = audioEl.value;
        if (!a || !duration.value) return;
        const rect = ev.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
        a.currentTime = ratio * duration.value;
        progress.value = a.currentTime;
      }
      function applyVolume() {
        const a = audioEl.value;
        muted.value = volume.value === 0;
        if (a) a.volume = muted.value ? 0 : volume.value;
      }
      function toggleMute() {
        muted.value = !muted.value;
        const a = audioEl.value;
        if (a) a.volume = muted.value ? 0 : volume.value;
      }

      /* ==================================================== 初始化 */
      /**
       * 启动自检：探测常见端口上是否已有服务在跑，找到就跳过去
       */
      async function retryBoot() {
        if (bootError.value && bootError.value.kind === 'model') {
          location.reload();
          return;
        }
        for (const p of [8010, 8011, 8012, 8013, 8014, 8015]) {
          try {
            const r = await fetch(`http://localhost:${p}/data/songs.json`, { cache: 'no-store' });
            if (r.ok) { location.href = `http://localhost:${p}/`; return; }
          } catch (e) { /* 该端口没服务，试下一个 */ }
        }
        toast('还没检测到本地服务，请先双击「启动系统.vbs」或 start.bat');
      }

      onMounted(async () => {
        // 0. 前置检查：file:// 协议下浏览器的 CORS 策略会拦掉所有 fetch，
        //    模型和曲库都读不到，与其让用户看到"模型加载失败"，不如直接讲清楚原因
        if (location.protocol === 'file:') {
          bootError.value = {
            kind: 'file',
            title: '请通过本地服务打开',
            desc: '你现在是直接双击 index.html 打开的（file:// 协议）。浏览器出于安全策略会拦掉页面发出的所有本地文件请求，所以情绪模型和曲库都读不到，摄像头也无法使用。',
            hint: '一句话：不能双击 index.html，要双击「启动系统.vbs」或 start.bat。',
          };
          loadingText.value = '需要本地服务';
          return;
        }

        // 1. 引擎
        engine.value = new Engine('models');
        try {
          await engine.value.load((p) => {
            loadingText.value = `${p.text}（${p.step + 1}/${p.total}）`;
          });
          modelReady.value = true;
          loadingText.value = '本地模型就绪';
          smoothingWindow.value = engine.value.windowSize;
        } catch (err) {
          loadingText.value = '模型加载失败';
          bootError.value = {
            kind: 'model',
            title: '本地模型加载失败',
            desc: '页面已经能打开，但 face-api 的权重文件没读到：' + (err.message || err),
            hint: '请检查 models/ 目录，应当有 6 个文件：3 个 *-weights_manifest.json 和 3 个 *-shard1。若文件齐全仍失败，按 Ctrl+F5 强制刷新一次。',
          };
        }

        // 2. 曲库
        try {
          localSongs.value = await Music.loadLocalSongs();
        } catch (err) {
          toast('本地曲库读取失败：' + (err.message || err));
        }

        // 3. 没有摄像头权限也能先给一份默认歌单（按「平静」）
        if (localSongs.value.length) {
          recommendations.value = Rec.recommend(localSongs.value, 'neutral', { limit: 12 });
          lastRecoEmotion = 'neutral';
          // 首次进入也把在线曲库补进来，避免「含在线曲库」勾着却没有在线歌
          if (includeOnline.value) setTimeout(() => refreshRecommendations(true), 400);
        }

        // 4. file:// 直接打开时提醒
        if (!window.isSecureContext) {
          toast('当前是 file:// 方式打开，摄像头不可用。请用 start-server 启动到 localhost。');
        }

        // 5. 调试出口：便于在控制台手动排查与答辩演示
        window.__moodtune = {
          engine,
          sourceType,
          lastResult,
          mainEmotion,
          recommendations,
          onlineErrors,
          loadingRec,
          get lastRecoEmotion() { return lastRecoEmotion; },
          refreshRecommendations,
          profile,
        };
      });

      onBeforeUnmount(() => {
        stopLoop();
        stopCameraStream();
        clearTimeout(recoTimer);
        clearTimeout(toastTimer);
      });

      return {
        // 状态
        engine, modelReady, loadingText, toastMsg, toast, bootError, retryBoot,
        sourceTabs, sourceType, isRunning, faceDetected, fps, detectMs,
        videoEl, photoEl, overlayEl, audioEl,
        photoDataUrl, videoLoaded, videoPaused, stageRatio,
        lastResult, mainEmotion, probs,
        localSongs, onlineSongs, recommendations, includeOnline, loadingRec, onlineErrors,
        current, isPlaying, progress, duration, volume, muted,
        // 计算属性
        cssVars, hasFrame, stageLabel, emptyHint, stableRatio, detail, smoothingWindow, progressPct,
        // 工具
        meta, profile, pct, fmtTime, coverBg, onCoverError,
        // 动作
        startCamera, stopAll, takePhoto, onPickImage, detectOnce,
        onPickVideo, toggleVideoPlay, switchSource,
        refreshRecommendations, playSong, togglePlay, nextSong, prevSong,
        onTimeUpdate, onMeta, onEnded, seek, applyVolume, toggleMute,
      };
    },
  }).mount('#app');
})();
