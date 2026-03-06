/**
 * Subtitle parser: SMI/SRT → WebVTT conversion
 */
(function () {
  function msToVttTime(ms) {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const ms3 = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s}.${ms3}`;
  }

  function buildVTT(cues) {
    let vtt = 'WEBVTT\n\n';
    for (const cue of cues) {
      vtt += `${cue.start} --> ${cue.end}\n${cue.text}\n\n`;
    }
    return vtt;
  }

  function parseSMI(text) {
    const cues = [];
    const syncRe = /<SYNC\s+Start\s*=\s*(\d+)\s*>/gi;
    const syncs = [];
    let m;
    while ((m = syncRe.exec(text)) !== null) {
      syncs.push({ time: parseInt(m[1], 10), idx: m.index + m[0].length });
    }

    for (let i = 0; i < syncs.length; i++) {
      const endIdx = i + 1 < syncs.length
        ? text.lastIndexOf('<SYNC', syncs[i + 1].idx)
        : text.length;
      let content = text.substring(syncs[i].idx, endIdx).trim();

      content = content.replace(/<P[^>]*>/gi, '').replace(/<\/P>/gi, '');
      content = content.replace(/<br\s*\/?>/gi, '\n');
      content = content.replace(/<[^>]+>/g, '');
      content = content.replace(/&nbsp;/gi, '').trim();

      if (!content) continue;

      const startMs = syncs[i].time;
      const endMs = i + 1 < syncs.length ? syncs[i + 1].time : startMs + 5000;

      cues.push({
        start: msToVttTime(startMs),
        end: msToVttTime(endMs),
        text: content,
      });
    }
    return buildVTT(cues);
  }

  function parseSRT(text) {
    const cues = [];
    const blocks = text.trim().replace(/\r\n/g, '\n').split(/\n\s*\n/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 2) continue;

      let timeLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) { timeLine = i; break; }
      }
      if (timeLine < 0) continue;

      const tm = lines[timeLine].match(
        /(\d{2}:\d{2}:\d{2}[,.]?\d{0,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]?\d{0,3})/
      );
      if (!tm) continue;

      cues.push({
        start: tm[1].replace(',', '.'),
        end: tm[2].replace(',', '.'),
        text: lines.slice(timeLine + 1).join('\n').trim(),
      });
    }
    return buildVTT(cues);
  }

  function parseSubtitle(text, filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'smi' || ext === 'sami') return parseSMI(text);
    if (ext === 'srt') return parseSRT(text);
    if (ext === 'vtt') return text;
    throw new Error('지원하지 않는 자막 형식입니다.');
  }

  window.SubtitleParser = { parseSubtitle };
})();
