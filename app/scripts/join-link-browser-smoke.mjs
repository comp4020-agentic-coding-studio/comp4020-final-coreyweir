// Opening a room's link (docs/adr/0006): a browser that isn't in the room
// is asked for a name first, with the last name it used filled in and
// selected; one that is in the room goes straight in. Guests only, so it
// runs against dev or live:
//   RIFF_URL=https://comp4020-final-coreyweir.fly.dev W=390 H=844 npm run test:join-link-browser
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.RIFF_URL ?? "http://127.0.0.1:8093";
const viewport = { width: Number(process.env.W ?? 1920), height: Number(process.env.H ?? 1080), deviceScaleFactor: 1 };
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const errors = [];
async function newPage() {
  const page = await (await browser.createBrowserContext()).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewport(viewport);
  return page;
}
const field = (page) => page.$eval(".join-link form input", (input) => ({
  value: input.value,
  focused: document.activeElement === input,
  selected: input.selectionStart === 0 && input.selectionEnd === input.value.length,
}));
const inRoom = (page) => page.waitForFunction(() => location.search.startsWith("?id=") && document.querySelector(".room-name"), { timeout: 15_000, polling: 100 });

try {
  const host = await newPage();
  await host.goto(baseUrl, { waitUntil: "networkidle0" });
  await host.click(".entry-card > nav button:nth-child(2)");
  await host.$(".model-choice label:nth-of-type(2) input").then((own) => own?.click());
  const inputs = await host.$$(".entry-card form input:not([type=radio])");
  await inputs[0].type("Hana");
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(`${baseUrl}/fake-anthropic`);
  await inputs[2].type("join-link-smoke");
  const keep = await host.$(".entry-card form label.check input[type=checkbox]");
  if (keep && await keep.evaluate((element) => element.checked)) await keep.click();
  await host.click(".entry-card form .primary");
  await inRoom(host);
  const code = (await host.$eval(".room-name span", (element) => element.textContent)).replace("Room ", "");
  const link = `${baseUrl}/?room=${code.toLowerCase()}`;

  // A fresh browser: asked for a name, nothing filled in.
  const fresh = await newPage();
  await fresh.goto(link, { waitUntil: "networkidle0" });
  await fresh.waitForSelector(".join-link form input");
  assert.match(await fresh.$eval(".join-link h2", (element) => element.textContent), new RegExp(`Join room ${code}`));
  assert.deepEqual(await field(fresh), { value: "", focused: true, selected: true });
  assert.equal(await fresh.$eval(".join-link .primary", (button) => button.disabled), true, "no joining without a name");
  await fresh.keyboard.type("Bo");
  await fresh.keyboard.press("Enter");
  await inRoom(fresh);
  console.log("fresh browser: asked for a name, joined as Bo");

  // The same browser opening the link again is in the room: straight in.
  await fresh.goto(link, { waitUntil: "domcontentloaded" });
  await inRoom(fresh);
  assert.equal(await fresh.$(".join-link"), null);
  console.log("member: the link goes straight into the room");

  // A browser that used a name elsewhere: filled in, selected, still asked.
  const named = await newPage();
  await named.goto(baseUrl, { waitUntil: "networkidle0" });
  await named.evaluate(() => localStorage.setItem("riff-name", "Old Name"));
  await named.goto(link, { waitUntil: "networkidle0" });
  await named.waitForSelector(".join-link form input");
  assert.deepEqual(await field(named), { value: "Old Name", focused: true, selected: true });
  await named.keyboard.type("Cy");
  assert.equal((await field(named)).value, "Cy", "typing replaces the filled-in name");
  await named.click(".join-link .primary");
  await inRoom(named);
  await host.waitForFunction(() => [...document.querySelectorAll(".participants span")].some((element) => element.title.startsWith("Cy")), { timeout: 10_000, polling: 100 });
  console.log("returning name: filled in and selected, replaced by typing, joined as Cy");

  // A name already taken in the room is refused on the same page.
  const twin = await newPage();
  await twin.goto(link, { waitUntil: "networkidle0" });
  await twin.waitForSelector(".join-link form input");
  await twin.keyboard.type("Bo");
  await twin.keyboard.press("Enter");
  await twin.waitForSelector(".join-link .form-error");
  assert.match(await twin.$eval(".join-link .form-error", (element) => element.textContent), /already goes by that name/);
  console.log("taken name: refused on the join page");

  // Once the room has ended, the link says so before asking for a name.
  await host.click("button.participants");
  await host.click(".end-room > button");
  await host.waitForSelector(".end-room.asking");
  await Promise.all([host.waitForNavigation({ waitUntil: "networkidle0" }), host.click(".end-room button.danger")]);
  const late = await newPage();
  await late.goto(link, { waitUntil: "networkidle0" });
  await late.waitForSelector(".join-link .no-room h2");
  assert.match(await late.$eval(".join-link .no-room", (element) => element.textContent), new RegExp(`No live room ${code}.*no live room with that code`));
  assert.equal(await late.$(".join-link form"), null, "no name asked for a room nobody can join");
  console.log("ended room: the link says there's no live room, before asking for a name");

  assert.deepEqual(errors, []);
  console.log(`join link browser smoke passed at ${viewport.width}x${viewport.height}`);
} finally {
  await browser.close();
}
