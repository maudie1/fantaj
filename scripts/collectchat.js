const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const MEMBERS_PATH = path.join(ROOT, "data", "members.json");
const CHATDATA_PATH = path.join(ROOT, "ranking", "chatdata.json");
const RANK_DIR = path.join(ROOT, "ranking");

const AUTO_START_DATE = "2026-05-30";
const MAX_VODS_PER_RUN = Number(process.env.MAX_VODS_PER_RUN || 5);
const VOD_LIST_PER_PAGE = 60;
const CHAT_STEP_SECONDS = 300;
const REQUEST_DELAY_MS = 120;

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`JSON 읽기 실패: ${filePath}`, error.message);
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function onlyDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function monthKey(value) {
  return onlyDate(value).slice(0, 7);
}

function normalizeId(value) {
  return String(value || "").trim();
}

function extractArrayFromUnknownResponse(data) {
  if (Array.isArray(data)) return data;

  const candidates = [
    data?.DATA,
    data?.data,
    data?.result,
    data?.RESULT,
    data?.DATA?.list,
    data?.data?.list,
    data?.DATA?.items,
    data?.data?.items,
    data?.DATA?.contents,
    data?.data?.contents
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  if (data && typeof data === "object") {
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") {
        for (const inner of Object.values(value)) {
          if (Array.isArray(inner)) return inner;
        }
      }
    }
  }

  return [];
}

function normalizeVod(item, bjId, bjName) {
  const titleNo = item.titleNo ?? item.title_no ?? item.broadNo ?? item.broad_no ?? item.bbsNo ?? item.bbs_no;
  const broadDate = item.broadDate ?? item.broad_date ?? item.regDate ?? item.reg_date ?? item.broadStart ?? item.broad_start;
  const titleName = item.titleName ?? item.title_name ?? item.broadTitle ?? item.broad_title ?? item.title ?? "";

  return {
    bjId,
    bjName,
    titleNo: normalizeId(titleNo),
    titleName: String(titleName || ""),
    broadDate: String(broadDate || "")
  };
}

async function fetchVodListForMember(member) {
  const bjId = normalizeId(member.soopId || member.userId || member.id);
  const bjName = String(member.name || member.nickname || bjId);
  const results = [];

  for (let page = 1; page <= 3; page += 1) {
    const url = `https://api-channel.sooplive.com/v1.1/channel/${encodeURIComponent(bjId)}/vod/review?startDate=&endDate=&keyword=&orderBy=regDate&perPage=${VOD_LIST_PER_PAGE}&page=${page}&field=title,contents,userNick,userId`;

    const response = await fetch(url, {
      headers: {
        "accept": "application/json,text/plain,*/*",
        "origin": "https://www.sooplive.com",
        "referer": "https://www.sooplive.com/"
      }
    });

    if (!response.ok) {
      console.warn(`[VOD 목록 실패] ${bjName} ${bjId} ${response.status}`);
      break;
    }

    const data = await response.json();
    const rawList = extractArrayFromUnknownResponse(data);
    if (!rawList.length) break;

    const normalized = rawList
      .map(item => normalizeVod(item, bjId, bjName))
      .filter(vod => vod.titleNo && vod.broadDate);

    results.push(...normalized);

    const oldestDate = normalized
      .map(vod => onlyDate(vod.broadDate))
      .filter(Boolean)
      .sort()[0];

    if (oldestDate && oldestDate < AUTO_START_DATE) break;
  }

  return results;
}

async function getVodFileItems(page, titleNo) {
  const url = `https://vod.sooplive.com/player/${encodeURIComponent(titleNo)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  await page.waitForFunction(() => {
    return window.vodCore &&
      Array.isArray(window.vodCore.fileItems) &&
      window.vodCore.fileItems.length > 0;
  }, { timeout: 60000 });

  return await page.evaluate(() => {
    return {
      fileItems: window.vodCore.fileItems.map(item => ({
        fileInfoKey: item.fileInfoKey,
        duration: Number(item.duration || 0)
      }))
    };
  });
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function extractTag(block, tagName) {
  const cdata = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tagName}>`, "i").exec(block);
  if (cdata) return cdata[1];

  const normal = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i").exec(block);
  if (normal) return decodeXml(normal[1].replace(/<[^>]+>/g, "").trim());

  return "";
}

function parseChatXml(xml) {
  const result = [];
  const chatBlocks = String(xml || "").match(/<chat\b[\s\S]*?<\/chat>/gi) || [];

  for (const block of chatBlocks) {
    const rawUserId = extractTag(block, "u");
    const userId = normalizeId(rawUserId.split("(")[0]);
    const nickname = extractTag(block, "n").trim();

    if (!userId) continue;

    result.push({
      userId,
      nickname: nickname || userId
    });
  }

  return result;
}

async function collectVodChat(browser, vod) {
  const page = await browser.newPage();
  let info;

  try {
    info = await getVodFileItems(page, vod.titleNo);
  } finally {
    await page.close().catch(() => {});
  }

  const userMap = new Map();

  for (const item of info.fileItems) {
    if (!item.fileInfoKey || !item.duration) continue;

    for (let startTime = 0; startTime <= item.duration; startTime += CHAT_STEP_SECONDS) {
      const chatUrl = `https://videoimg.sooplive.com/php/ChatLoadSplit.php?rowKey=${encodeURIComponent(item.fileInfoKey + "_c")}&startTime=${startTime}`;

      try {
        const response = await fetch(chatUrl, {
          headers: {
            "accept": "text/plain,*/*",
            "referer": `https://vod.sooplive.com/player/${vod.titleNo}`
          }
        });

        if (!response.ok) {
          console.warn(`[채팅 요청 실패] ${vod.titleNo} ${startTime} ${response.status}`);
          continue;
        }

        const xml = await response.text();
        const chats = parseChatXml(xml);

        for (const chat of chats) {
          const prev = userMap.get(chat.userId) || { chat: 0, nickname: chat.nickname };
          prev.chat += 1;
          prev.nickname = chat.nickname || prev.nickname;
          userMap.set(chat.userId, prev);
        }
      } catch (error) {
        console.warn(`[채팅 수집 오류] ${vod.titleNo} ${startTime}`, error.message);
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  const vodDate = onlyDate(vod.broadDate);

  return [...userMap.entries()].map(([userId, data]) => ({
    source: "auto",
    bjId: vod.bjId,
    bjName: vod.bjName,
    vodNo: vod.titleNo,
    vodDate,
    userId,
    nickname: data.nickname,
    chat: data.chat
  }));
}

function buildChatRank(records) {
  const byUser = new Map();
  const latestNick = new Map();

  for (const record of records) {
    const id = normalizeId(record.userId || record.id);
    if (!id) continue;

    const prev = byUser.get(id) || {
      rank: 0,
      id,
      nickname: record.nickname || id,
      chat: 0,
      balloon: 0,
      donateCount: 0,
      topword: "",
      date: ""
    };

    prev.chat += Number(record.chat || 0);

    if (record.vodDate && String(record.vodDate) >= String(prev.date || "")) {
      prev.date = record.vodDate;
    }

    byUser.set(id, prev);

    const keyDate = String(record.vodDate || "");
    const old = latestNick.get(id);
    if (!old || keyDate >= old.date) {
      latestNick.set(id, {
        date: keyDate,
        nickname: record.nickname || prev.nickname
      });
    }
  }

  for (const [id, info] of latestNick.entries()) {
    const target = byUser.get(id);
    if (target) target.nickname = info.nickname || target.nickname;
  }

  return [...byUser.values()]
    .filter(user => Number(user.chat || 0) > 0)
    .sort((a, b) => Number(b.chat || 0) - Number(a.chat || 0))
    .map((user, index) => ({ ...user, rank: index + 1 }));
}

function buildChatRanks(chatdata) {
  const records = Array.isArray(chatdata.records) ? chatdata.records : [];

  writeJson(path.join(RANK_DIR, "chatrank.json"), buildChatRank(records));

  const months = new Set(records.map(record => monthKey(record.vodDate)).filter(Boolean));
  months.add(AUTO_START_DATE.slice(0, 7));

  for (const ym of [...months].sort()) {
    const monthRecords = records.filter(record => monthKey(record.vodDate) === ym);
    writeJson(path.join(RANK_DIR, `chatrank_${ym}.json`), buildChatRank(monthRecords));
  }
}

async function main() {
  if (!fs.existsSync(MEMBERS_PATH)) {
    throw new Error("data/members.json 파일이 없습니다.");
  }

  const members = readJson(MEMBERS_PATH, [])
    .filter(member => member && normalizeId(member.soopId || member.userId || member.id));

  const chatdata = readJson(CHATDATA_PATH, {
    autoStartDate: AUTO_START_DATE,
    collectedVods: {},
    records: []
  });

  chatdata.autoStartDate = chatdata.autoStartDate || AUTO_START_DATE;
  chatdata.collectedVods = chatdata.collectedVods || {};
  chatdata.records = Array.isArray(chatdata.records) ? chatdata.records : [];

  const candidates = [];

  for (const member of members) {
    const bjId = normalizeId(member.soopId || member.userId || member.id);
    const bjName = String(member.name || bjId);
    const list = await fetchVodListForMember({ ...member, soopId: bjId, name: bjName });

    const collected = new Set(chatdata.collectedVods[bjId] || []);

    for (const vod of list) {
      const vodDate = onlyDate(vod.broadDate);
      if (!vodDate || vodDate < chatdata.autoStartDate) continue;
      if (collected.has(String(vod.titleNo))) continue;
      candidates.push(vod);
    }
  }

  candidates.sort((a, b) => String(a.broadDate).localeCompare(String(b.broadDate)));

  const targets = candidates.slice(0, MAX_VODS_PER_RUN);
  console.log(`새 VOD 후보 ${candidates.length}개, 이번 실행 처리 ${targets.length}개`);

  let browser = null;

  try {
    if (targets.length) {
      browser = await chromium.launch({ headless: true });

      for (const vod of targets) {
        console.log(`[수집 시작] ${vod.bjName} ${vod.titleNo} ${vod.broadDate} ${vod.titleName}`);

        const records = await collectVodChat(browser, vod);

        chatdata.records.push(...records);
        chatdata.collectedVods[vod.bjId] = chatdata.collectedVods[vod.bjId] || [];
        chatdata.collectedVods[vod.bjId].push(String(vod.titleNo));

        console.log(`[수집 완료] ${vod.titleNo} 사용자 ${records.length}명`);

        buildChatRanks(chatdata);
        writeJson(CHATDATA_PATH, chatdata);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  buildChatRanks(chatdata);
  writeJson(CHATDATA_PATH, chatdata);

  console.log("채팅 랭킹 생성 완료");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
