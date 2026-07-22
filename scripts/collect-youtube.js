import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const configPath = path.join(root, 'config', 'creator-search.json');
const outputPath = path.join(root, 'data', 'recommendations.json');
const apiKey = process.env.YOUTUBE_API_KEY;

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const existing = fs.existsSync(outputPath)
  ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
  : { platformStatus: {}, brands: { dartsnut: [], chessnut: [] } };

function tierFor(followers) {
  if (followers >= 300000) return '大型 KOL';
  if (followers >= 50000) return '中腰部';
  return '小而美';
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function keywords(texts, limit = 14) {
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'you', 'are', 'our', 'new', 'how', 'best', 'video', 'videos', 'shorts', 'official', 'channel']);
  const counts = new Map();
  for (const text of texts) {
    for (const word of String(text || '').match(/[A-Za-z][A-Za-z0-9+#-]{2,}/g) || []) {
      const term = word.toLowerCase();
      if (!stop.has(term)) counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, count]) => ({ term, count }));
}

function isoWeek(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()} W${String(week).padStart(2, '0')}`;
}

async function youtube(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries({ ...params, key: apiKey }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`YouTube API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function collect() {
  if (!apiKey) {
    existing.platformStatus = { ...existing.platformStatus, youtube: 'missing_api_key' };
    fs.writeFileSync(outputPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    return;
  }

  const found = { dartsnut: new Map(), chessnut: new Map() };
  const perQuery = Number(config.settings.perQuery || 4);
  const recentCount = Number(config.settings.recentPosts || 6);

  for (const [brand, brandConfig] of Object.entries(config.brands)) {
    for (const [track, queries] of Object.entries(brandConfig.tracks)) {
      for (const query of queries) {
        const search = await youtube('search', { part: 'snippet', type: 'channel', maxResults: perQuery, q: query, relevanceLanguage: 'en', safeSearch: 'moderate' });
        for (const item of search.items || []) {
          const channelId = item.snippet?.channelId || item.id?.channelId;
          if (channelId && !found[brand].has(channelId)) found[brand].set(channelId, { track, query });
        }
      }
    }
  }

  const channelIds = [...new Set(Object.values(found).flatMap(store => [...store.keys()]))];
  const channelMap = new Map();
  for (let index = 0; index < channelIds.length; index += 50) {
    const data = await youtube('channels', { part: 'snippet,statistics,contentDetails', id: channelIds.slice(index, index + 50).join(',') });
    for (const item of data.items || []) channelMap.set(item.id, item);
  }

  const recentByChannel = new Map();
  const videoIds = [];
  for (const channelId of channelIds) {
    const uploads = channelMap.get(channelId)?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) continue;
    const data = await youtube('playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: recentCount });
    const entries = (data.items || []).map(item => ({
      id: item.contentDetails?.videoId,
      title: item.snippet?.title || '',
      publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || ''
    })).filter(item => item.id);
    recentByChannel.set(channelId, entries);
    videoIds.push(...entries.map(item => item.id));
  }

  const videoMap = new Map();
  for (let index = 0; index < videoIds.length; index += 50) {
    const data = await youtube('videos', { part: 'snippet,statistics', id: videoIds.slice(index, index + 50).join(',') });
    for (const item of data.items || []) videoMap.set(item.id, item);
  }

  const brands = {};
  for (const [brand, store] of Object.entries(found)) {
    const preserved = (existing.brands?.[brand] || []).filter(item => item.platform !== 'YouTube');
    const youtubeCandidates = [];
    for (const [channelId, match] of store.entries()) {
      const channel = channelMap.get(channelId);
      if (!channel) continue;
      const followers = Number(channel.statistics?.subscriberCount || 0);
      const recentPosts = (recentByChannel.get(channelId) || []).map(entry => {
        const video = videoMap.get(entry.id);
        return {
          title: entry.title,
          url: `https://www.youtube.com/watch?v=${entry.id}`,
          views: Number(video?.statistics?.viewCount || 0),
          likes: Number(video?.statistics?.likeCount || 0),
          comments: Number(video?.statistics?.commentCount || 0),
          publishedAt: entry.publishedAt
        };
      });
      const views = recentPosts.reduce((sum, post) => sum + post.views, 0);
      const interactions = recentPosts.reduce((sum, post) => sum + post.likes + post.comments, 0);
      const engagementRate = views ? Number((interactions / views * 100).toFixed(2)) : 0;
      const snippet = channel.snippet || {};
      youtubeCandidates.push({
        id: `youtube-${channelId}`,
        name: snippet.title || channelId,
        handle: snippet.customUrl || channelId,
        platform: 'YouTube',
        track: match.track,
        tier: tierFor(followers),
        followers,
        avgViews: average(recentPosts.map(post => post.views)),
        engagementRate,
        email: '',
        bio: snippet.description || '',
        channelUrl: `https://www.youtube.com/channel/${channelId}`,
        avatarUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
        recentPosts,
        keywords: keywords([snippet.description, ...recentPosts.map(post => post.title)]),
        reason: `通过“${match.query}”找到，与“${match.track}”赛道匹配。`,
        score: Math.min(100, Math.round(50 + Math.min(engagementRate, 10) * 3 + Math.log10(Math.max(followers, 10)) * 4)),
        source: 'YouTube Data API public data'
      });
    }
    brands[brand] = [...preserved, ...youtubeCandidates]
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, Number(config.settings.maxPerBrand || 30));
  }

  const now = new Date();
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: now.toISOString(),
    week: isoWeek(now),
    platformStatus: { ...existing.platformStatus, youtube: channelIds.length ? 'success' : 'no_results' },
    brands
  }, null, 2) + '\n', 'utf8');
}

collect().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
