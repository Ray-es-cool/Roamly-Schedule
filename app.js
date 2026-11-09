import {
  inferTripContext,
  assignActivityToDay,
  buildFollowUpQuestion,
  resolveTripDayKey,
  buildGoogleMapsUrl,
  buildDepartureReminder,
  buildTripManagementPrompt,
  normalizeScheduleEntry,
  buildTimeAwareDaySummary,
  buildRoamlyJrWelcomeSequence,
  buildTripCreatedGuidance
} from "./scheduler-logic.js";

const KEY = "roamly_schedule_trips_v1";
const CLOUD_USER_ID_KEY = "roamly_cloud_user_id_v1";
const AUTH_USER_KEY = "roamly_auth_user_v1";
const AUTH_USERS_KEY = "roamly_auth_users_v1";
const ONBOARDING_KEY = "roamly_onboarding_seen_v1";
const LAST_TRIP_KEY = "roamly_last_trip_id_v1";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .catch(error => console.warn("Service worker registration failed:", error));
  });
}

function getCloudUserId() {
  const saved = localStorage.getItem(CLOUD_USER_ID_KEY);

  if (saved && String(saved).trim()) {
    return String(saved).trim();
  }

  const generated = `roamly-user-${crypto.randomUUID().slice(0, 8)}`;
  localStorage.setItem(CLOUD_USER_ID_KEY, generated);
  return generated;
}

async function syncTripsToCloud() {
  try {
    const response = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: getCloudUserId(),
        trips
      })
    });

    if (!response.ok) {
      throw new Error(`Cloud sync failed: ${response.status}`);
    }

    const payload = await response.json();

    if (Array.isArray(payload.trips)) {
      trips = payload.trips;
    }

    localStorage.setItem(KEY, JSON.stringify(trips));
    return true;
  } catch (error) {
    console.warn("Cloud sync unavailable; using local storage fallback.", error);
    localStorage.setItem(KEY, JSON.stringify(trips));
    return false;
  }
}

async function hydrateTripsFromCloud() {
  try {
    const response = await fetch(`/api/trips?userId=${encodeURIComponent(getCloudUserId())}`);

    if (!response.ok) {
      throw new Error(`Trip fetch failed: ${response.status}`);
    }

    const payload = await response.json();
    const serverTrips = Array.isArray(payload.trips) ? payload.trips : [];

    if (serverTrips.length) {
      trips = serverTrips;
    } else {
      trips = JSON.parse(localStorage.getItem(KEY) || "[]");
    }

    localStorage.setItem(KEY, JSON.stringify(trips));
    return true;
  } catch (error) {
    console.warn("Unable to load cloud trips; using local cache.", error);
    trips = JSON.parse(localStorage.getItem(KEY) || "[]");
    return false;
  }
}

let trips = JSON.parse(localStorage.getItem(KEY) || "[]");
let currentTrip = null;
let appUserLocation = null;
let currentUser = null;
let onboardingSteps = buildRoamlyJrWelcomeSequence();
let currentOnboardingStep = 0;
let onboardingFallbackTimer = null;
let onboardingInterrupted = false;
let onboardingPausedForCreate = false;

function readCurrentUser() {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && parsed.email ? parsed : null;
  } catch (error) {
    return null;
  }
}

function readUsers() {
  try {
    const raw = localStorage.getItem(AUTH_USERS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeUsers(users) {
  localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(users || {}));
}

function saveCurrentUser(user) {
  currentUser = user && user.email ? user : null;

  if (currentUser) {
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(currentUser));
    localStorage.setItem(ONBOARDING_KEY, "1");
  } else {
    localStorage.removeItem(AUTH_USER_KEY);
  }

  updateAuthUi();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function createAccount(name, email, password) {
  const safeName = String(name || "").trim();
  const safeEmail = normalizeEmail(email);
  const safePassword = String(password || "").trim();

  if (!safeName || !safeEmail || !safePassword) {
    return { ok: false, message: "Please fill in your name, email, and password." };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
    return { ok: false, message: "Please enter a valid email address." };
  }

  if (safePassword.length < 6) {
    return { ok: false, message: "Password must be at least 6 characters long." };
  }

  const users = readUsers();
  if (users[safeEmail]) {
    return { ok: false, message: "An account with that email already exists." };
  }

  users[safeEmail] = {
    name: safeName,
    email: safeEmail,
    password: safePassword
  };

  writeUsers(users);
  saveCurrentUser({ email: safeEmail, name: safeName });

  return { ok: true, message: "Account created successfully." };
}

function loginWithEmail(email, password) {
  const safeEmail = normalizeEmail(email);
  const safePassword = String(password || "").trim();

  if (!safeEmail || !safePassword) {
    return { ok: false, message: "Please enter your email and password." };
  }

  const users = readUsers();
  const user = users[safeEmail];

  if (!user || user.password !== safePassword) {
    return { ok: false, message: "Incorrect email or password." };
  }

  saveCurrentUser({ email: user.email, name: user.name || user.email.split("@")[0] });
  return { ok: true, message: "Logged in successfully." };
}

function getActiveUserId() {
  return currentUser?.email || getCloudUserId();
}

currentUser = readCurrentUser();

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday"
];

const $ = id => document.getElementById(id);


// ==========================================
// STORAGE
// ==========================================

function saveTrips() {
  localStorage.setItem(KEY, JSON.stringify(trips));
  syncTripsToCloud();
}

function saveCurrentTrip() {
  if (!currentTrip) return;

  ensureTripStructure();

  const index = trips.findIndex(t => t.id === currentTrip.id);

  if (index === -1) {
    trips.push(currentTrip);
  } else {
    trips[index] = currentTrip;
  }

  localStorage.setItem(LAST_TRIP_KEY, String(currentTrip.id));
  saveTrips();
}

function restoreLastTripReference() {
  const saved = localStorage.getItem(LAST_TRIP_KEY);

  if (!saved) {
    return trips[trips.length - 1] || null;
  }

  return trips.find(trip => String(trip.id) === String(saved)) || trips[trips.length - 1] || null;
}

async function syncTripsFromStorage() {
  try {
    const cloudReady = await hydrateTripsFromCloud();

    if (cloudReady && currentTrip) {
      const savedTrip = trips.find(trip => trip.id === currentTrip.id);

      if (savedTrip) {
        currentTrip = savedTrip;
        ensureTripStructure();
        restoreChatHistory();
        renderDestinations();
        renderSchedule();
      }
    }

    if (!cloudReady) {
      const stored = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (Array.isArray(stored)) {
        trips = stored;
      }
    }
  } catch (error) {
    console.error("Failed to sync saved trips:", error);
  }
}

window.addEventListener("storage", event => {
  if (event.key === KEY) {
    syncTripsFromStorage();
  }
});


// ==========================================
// HTML SAFETY
// ==========================================

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

let expandedScheduleDay = null;

function normalizeStoredEntry(entry) {
  return normalizeScheduleEntry(entry);
}

function getScheduleEntryName(value) {
  return String(normalizeStoredEntry(value).name || "").trim().toLowerCase();
}

function formatScheduleTime(value = "") {
  if (!value) return "Time TBD";

  const [hourRaw, minuteRaw] = String(value).split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw || 0);

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return value;
  }

  const suffix = hour >= 12 ? "PM" : "AM";
  const normalizedHour = ((hour + 11) % 12) + 1;
  return `${normalizedHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function scheduleTimedReminders() {
  if (!currentTrip) return;

  const reminderWindows = [];

  Object.entries(currentTrip.schedule || {}).forEach(([dayKey, items]) => {
    if (!Array.isArray(items)) return;
    items.forEach(item => {
      const entry = normalizeStoredEntry(item);
      if (!entry.name || !entry.time || !entry.reminderMinutes) return;
      const dateValue = dayKey.includes("-") ? dayKey : resolveTripDayKey(dayKey, currentTrip);
      if (!dateValue || !dateValue.includes("-")) return;
      const scheduledDate = new Date(`${dateValue}T${entry.time}:00`);
      if (Number.isNaN(scheduledDate.getTime())) return;
      const reminderAt = new Date(scheduledDate.getTime() - entry.reminderMinutes * 60000);
      if (reminderAt <= new Date()) return;
      reminderWindows.push({
        name: entry.name,
        location: entry.location || currentTrip.country || "",
        travelMinutes: Number(entry.reason?.match(/\d+/)?.[0] || 20) || 20,
        reminderMinutes: entry.reminderMinutes,
        reminderAt,
        reminderText: buildDepartureReminder({
          name: entry.name,
          location: entry.location || currentTrip.country || "",
          minutesBefore: entry.reminderMinutes,
          travelMinutes: Number(entry.reason?.match(/\d+/)?.[0] || 20) || 20,
          weather: "rainy",
          closingSoon: true
        })
      });
    });
  });

  reminderWindows.sort((a, b) => a.reminderAt - b.reminderAt);

  const existingTimers = window.__roamlyReminderTimers || [];
  existingTimers.forEach(timer => clearTimeout(timer));
  window.__roamlyReminderTimers = [];

  reminderWindows.slice(0, 6).forEach(windowItem => {
    const delay = Math.max(0, windowItem.reminderAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      triggerDepartureReminder({
        name: windowItem.name,
        location: windowItem.location,
        travelMinutes: Number(windowItem.travelMinutes || windowItem.reminderText.match(/\d+/)?.[0] || 20),
        reminderMinutes: windowItem.reminderMinutes || 30
      });
    }, delay);
    window.__roamlyReminderTimers.push(timer);
  });
}

function openGoogleMapsForDestination(name, location = "") {
  const url = buildGoogleMapsUrl(name, location);
  window.open(url, "_blank", "noopener,noreferrer");
}

function requestReminderPermission() {
  if (!("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "granted") {
    return true;
  }

  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }

  return Notification.permission === "granted";
}

function triggerDepartureReminder(destination = {}) {
  const name = destination.name || "your destination";
  const location = destination.location || currentTrip?.country || "";
  const travelMinutes = Number(destination.travelMinutes || destination.driveMinutes || destination.walkMinutes || 20);
  const reminderText = buildDepartureReminder({
    name,
    location,
    minutesBefore: 30,
    travelMinutes,
    weather: "rainy",
    closingSoon: true
  });

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Roamly departure reminder", {
      body: reminderText,
      tag: `roamly-${name.toLowerCase().replace(/\s+/g, "-")}`
    });
  }

  showInAppStayReminder(reminderText);
  requestReminderPermission();
  return reminderText;
}

function renderTripManagementPrompt() {
  const box = document.getElementById("tripManagementPrompt");
  if (!box || !currentTrip) return;

  if (box.dataset.reminderActive === "true") {
    return;
  }

  box.textContent = buildTripManagementPrompt(currentTrip);
  box.classList.remove("reminder-active");
}

function showInAppStayReminder(message = "") {
  const box = document.getElementById("tripManagementPrompt");
  if (!box) return;

  const reminderText = message || "Roamly reminder: it is time to get ready for your trip.";
  box.textContent = reminderText;
  box.dataset.reminderActive = "true";
  box.classList.add("reminder-active");

  if (window.__roamlyInAppReminderTimer) {
    clearTimeout(window.__roamlyInAppReminderTimer);
  }

  window.__roamlyInAppReminderTimer = setTimeout(() => {
    box.dataset.reminderActive = "false";
    box.classList.remove("reminder-active");
    renderTripManagementPrompt();
  }, 10 * 60 * 1000);
}

function openScheduleTimeEditor(dayKey, entryName) {
  if (!currentTrip || !dayKey || !entryName) return;

  const key = resolveTripDayKey(dayKey, currentTrip) || dayKey;
  const match = (currentTrip.schedule?.[key] || []).find(item => normalizeStoredEntry(item).name.toLowerCase() === String(entryName).toLowerCase());
  const currentValue = normalizeStoredEntry(match || { name: entryName });

  const editor = document.getElementById("scheduleTimeEditor");
  const timeInput = document.getElementById("scheduleTimeInput");
  const reminderInput = document.getElementById("scheduleReminderInput");
  const title = document.getElementById("scheduleTimeTitle");

  if (!editor || !timeInput || !reminderInput || !title) return;

  const selectedTime = currentValue.time || "09:00";
  const selectedReminder = Number(currentValue.reminderMinutes || 30);

  editor.dataset.dayKey = key;
  editor.dataset.entryName = currentValue.name || entryName;
  timeInput.value = selectedTime;
  reminderInput.value = String(selectedReminder);
  title.textContent = `Set time for ${currentValue.name || entryName}`;
  editor.classList.remove("hidden");
}

function closeScheduleTimeEditor() {
  const editor = document.getElementById("scheduleTimeEditor");
  if (editor) {
    editor.classList.add("hidden");
    editor.dataset.dayKey = "";
    editor.dataset.entryName = "";
  }
}

function saveScheduleTimeEditor() {
  const editor = document.getElementById("scheduleTimeEditor");
  if (!editor || !currentTrip) return;

  const dayKey = editor.dataset.dayKey;
  const entryName = editor.dataset.entryName;
  const timeInput = document.getElementById("scheduleTimeInput");
  const reminderInput = document.getElementById("scheduleReminderInput");

  if (!dayKey || !entryName || !timeInput || !reminderInput) return;

  const timeValue = String(timeInput.value || "").trim();
  const reminderMinutes = Number(reminderInput.value || 30);

  if (!currentTrip.schedule[dayKey]) {
    currentTrip.schedule[dayKey] = [];
  }

  currentTrip.schedule[dayKey] = currentTrip.schedule[dayKey].map(item => {
    const normalized = normalizeStoredEntry(item);
    if (normalized.name.toLowerCase() !== String(entryName).toLowerCase()) return item;
    return {
      ...normalized,
      time: normalizeScheduleEntry({ time: timeValue }).time || normalized.time,
      reminderMinutes: Number.isFinite(reminderMinutes) ? Math.max(0, reminderMinutes) : normalized.reminderMinutes,
      reason: normalized.reason || `${normalized.name} is a planned trip stop.`
    };
  });

  saveCurrentTrip();
  renderSchedule();
  scheduleTimedReminders();
  closeScheduleTimeEditor();
}

function setScheduleTimeForDay(dayKey, entryName) {
  openScheduleTimeEditor(dayKey, entryName);
}


// ==========================================
// TRIPS
// ==========================================

function renderSavedTrips() {
  const box = $("savedTrips");

  if (!box) return;

  if (!trips.length) {
    box.innerHTML = "";
    return;
  }

  const latestTrip = trips[trips.length - 1];
  const tripName = latestTrip?.name || "Your trip";
  const tripDetails = latestTrip?.destinations?.length
    ? `${latestTrip.destinations.length} saved stop${latestTrip.destinations.length === 1 ? "" : "s"}`
    : "Fresh itinerary ready";
  const tripDate = latestTrip?.created
    ? `Updated ${new Date(latestTrip.created).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "Saved on this device";

  box.innerHTML = `
    <div class="trip-resume-banner">
      <div class="resume-banner-copy">
        <span class="live-pill"><i></i> Saved trip</span>
        <strong>Welcome back. ${escapeHtml(tripName)} is ready.</strong>
      </div>

      <button class="secondary-btn small" id="quickContinue">
        Resume trip
      </button>
    </div>

    <div class="trip-card recent-trip-card">
      <div>
        <strong>${escapeHtml(tripName)}</strong>
        <small>${escapeHtml(tripDetails)} • ${escapeHtml(tripDate)}</small>
      </div>

      <button class="secondary-btn small" id="quickOpenTrip">
        Open →
      </button>
    </div>
  `;

  const resumeBtn = $("quickContinue");
  if (resumeBtn) {
    resumeBtn.onclick = () => {
      if (trips.length) {
        openTrip(trips.length - 1);
      } else {
        openTrips();
      }
    };
  }

  const openBtn = $("quickOpenTrip");
  if (openBtn) {
    openBtn.onclick = () => {
      if (trips.length) {
        openTrip(trips.length - 1);
      } else {
        openTrips();
      }
    };
  }
}

function buildSuggestionButtons(suggestions = []) {
  const row = document.createElement("div");
  row.className = "suggestion-row";

  suggestions.forEach(suggestion => {
    const label = suggestion?.label || suggestion?.value || "Continue";
    const value = suggestion?.value || label;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-chip";
    button.textContent = label;
    button.dataset.prompt = value;
    button.onclick = () => {
      const chatInput = $("chatInput");
      if (chatInput) {
        chatInput.value = value;
        sendChat();
      }
    };
    row.appendChild(button);
  });

  return row;
}

function showStarterPrompt() {
  const chatWindow = $("chatWindow");

  if (!chatWindow) return;

  chatWindow.innerHTML = "";

  const starterSuggestions = [
    "Find beaches near my hotel",
    "Recommend local food spots",
    "Plan my first full day",
    "Add these places to my schedule"
  ];

  const wrapper = document.createElement("div");
  wrapper.className = "message ai-message";
  wrapper.innerHTML = `
    <div class="message-avatar">JR</div>

    <div>
      <div class="message-name">Roamly.Jr.</div>

      <p>
        I can build the trip, shape the itinerary, and keep everything organized around your dates.
      </p>

      <p>
        Send me the essentials and I’ll take it from there:<br>
        • where you are staying<br>
        • the country or city you are visiting<br>
        • your trip dates<br>
        • the kind of trip you want<br>
        • any must-see spots or food preferences
      </p>

      <p>
        Example: “I’ll be staying at the Marriott in Guyana from January 10, 2026 to January 17, 2026. I want beaches, food, and day trips.”
      </p>
    </div>
  `;

  chatWindow.appendChild(wrapper);
  chatWindow.appendChild(buildSuggestionButtons(starterSuggestions.map(value => ({ label: value, value }))));
}

function showUsageLimitModal(message = "Roamly.Jr. is temporarily unavailable. Please try again in a moment.") {
  const modal = $("usageLimitModal");
  const text = $("usageLimitMessage");

  if (!modal || !text) return;

  text.textContent = message;
  modal.classList.remove("hidden");
}

function hideUsageLimitModal() {
  const modal = $("usageLimitModal");

  if (modal) {
    modal.classList.add("hidden");
  }
}

function restoreChatHistory() {
  if (!currentTrip) return;

  const chatWindow = $("chatWindow");

  if (!chatWindow) return;

  chatWindow.innerHTML = "";

  const entries = Array.isArray(currentTrip.chatHistory) ? currentTrip.chatHistory : [];

  if (!entries.length) {
    showStarterPrompt();
    return;
  }

  entries.forEach(entry => {
    if (entry.type === "user") {
      addUserMessage(entry.text, false);
    } else if (entry.type === "ai") {
      addAIMessage(entry.text, false);
    }
  });
}


function openTrips() {
  $("tripList").innerHTML = trips.length
    ? trips.map((trip, index) => `
        <div class="trip-card" style="margin:10px 0">
          <div>
            <strong>${escapeHtml(trip.name)}</strong>
            <small>Trip ${index + 1}</small>
          </div>

          <button class="primary-btn small" data-trip="${index}">
            Open →
          </button>
        </div>
      `).join("")
    : `<p>No saved trips yet. Create your first adventure.</p>`;

  $("tripModal").classList.remove("hidden");

  document.querySelectorAll("[data-trip]").forEach(button => {
    button.onclick = () => {
      openTrip(Number(button.dataset.trip));
    };
  });
}


function openTrip(index) {
  currentTrip = trips[index];

  ensureTripStructure();
  saveCurrentTrip();

  $("tripModal").classList.add("hidden");
  $("homeView").classList.add("hidden");
  $("plannerView").classList.remove("hidden");

  $("currentTripName").textContent = currentTrip.name;
  $("scheduleTitle").textContent = currentTrip.name;

  restoreChatHistory();
  renderDestinations();
  renderSchedule();
}


function createTrip() {
  const name = $("tripName").value.trim();

  if (!name) return;

  if (!currentUser && onboardingPausedForCreate) {
    onboardingPausedForCreate = false;
    hideMascotWalkthrough();
    setTimeout(() => showMascotWalkthrough(2), 150);
  }

  currentTrip = {
    id: crypto.randomUUID(),
    name,
    created: Date.now(),

    hotel: "",
    country: "",
    homePoint: {
      hotel: "",
      country: ""
    },
    startDate: "",
    endDate: "",
    stayLengthDays: undefined,

    destinations: [],
    chatHistory: [],

    schedule: {
      Monday: [],
      Tuesday: [],
      Wednesday: [],
      Thursday: [],
      Friday: [],
      Saturday: [],
      Sunday: []
    }
  };

  trips.push(currentTrip);

  saveTrips();

  $("tripName").value = "";
  $("newTripModal").classList.add("hidden");
  $("homeView").classList.add("hidden");
  $("plannerView").classList.remove("hidden");

  $("currentTripName").textContent = name;
  $("scheduleTitle").textContent = name;

  renderSavedTrips();
  if (trips.length && trips[trips.length - 1]) {
    currentTrip = trips[trips.length - 1];
    ensureTripStructure();
    restoreChatHistory();
  }
  restoreChatHistory();
  renderDestinations();
  renderSchedule();

  if (!currentUser && $("mascotOnboarding") && !$("mascotOnboarding").classList.contains("hidden") && currentOnboardingStep === 1) {
    setTimeout(() => {
      onboardingPausedForCreate = false;
      advanceMascotWalkthrough();
    }, 350);
  }
}


function getDateKey(date) {
  const local = new Date(date);
  local.setHours(12, 0, 0, 0);
  return local.toISOString().slice(0, 10);
}

function getTripMonthDate(trip = currentTrip) {
  if (!trip) return new Date();

  const source = trip.startDate || trip.tripDates?.startDate || new Date().toISOString().slice(0, 10);
  const parsed = new Date(`${source}T12:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

function getCalendarMonthDays(referenceDate = new Date()) {
  const monthStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
  const startOffset = (monthStart.getDay() + 6) % 7;
  const days = [];

  for (let i = 0; i < 42; i++) {
    const cur = new Date(monthStart);
    cur.setDate(monthStart.getDate() - startOffset + i);
    days.push(cur);
  }

  return days;
}

function formatTripDateRange(trip = currentTrip) {
  if (!trip) return "Trip dates not set";

  if (trip.startDate && trip.endDate) {
    const start = new Date(`${trip.startDate}T12:00:00`);
    const end = new Date(`${trip.endDate}T12:00:00`);
    const options = { month: "short", day: "numeric", year: "numeric" };
    return `${start.toLocaleDateString("en-US", options)} → ${end.toLocaleDateString("en-US", options)}`;
  }

  return "Trip dates not set";
}

// ==========================================
// TRIP STRUCTURE
// ==========================================

function ensureTripStructure() {
  if (!currentTrip) return;

  if (!currentTrip.userLocation) {
    currentTrip.userLocation = null;
  }

  if (!Array.isArray(currentTrip.destinations)) {
    currentTrip.destinations = [];
  }

  if (!Array.isArray(currentTrip.chatHistory)) {
    currentTrip.chatHistory = [];
  }

  if (!currentTrip.schedule) {
    currentTrip.schedule = {};
  }

  DAYS.forEach(day => {
    if (!Array.isArray(currentTrip.schedule[day])) {
      currentTrip.schedule[day] = [];
    }
    currentTrip.schedule[day] = currentTrip.schedule[day].map(item => normalizeStoredEntry(item));
  });

  if (!currentTrip.hotel) {
    currentTrip.hotel = "";
  }

  if (!currentTrip.country) {
    currentTrip.country = "";
  }

  if (!currentTrip.homePoint) {
    currentTrip.homePoint = {
      hotel: currentTrip.hotel || "",
      country: currentTrip.country || ""
    };
  }

  if (currentTrip.homePoint && !currentTrip.homePoint.hotel && currentTrip.hotel) {
    currentTrip.homePoint.hotel = currentTrip.hotel;
  }

  if (currentTrip.homePoint && !currentTrip.homePoint.country && currentTrip.country) {
    currentTrip.homePoint.country = currentTrip.country;
  }

  if (!currentTrip.startDate && currentTrip.tripDates?.startDate) {
    currentTrip.startDate = currentTrip.tripDates.startDate;
  }

  if (!currentTrip.endDate && currentTrip.tripDates?.endDate) {
    currentTrip.endDate = currentTrip.tripDates.endDate;
  }
}


// ==========================================
// DESTINATIONS
// ==========================================

function renderDestinations() {
  const box = $("destinationList");

  if (!box || !currentTrip) return;

  if (!currentTrip.destinations.length) {
    box.innerHTML = `
      <div class="empty-destinations">
        No destinations yet.
      </div>
    `;
    return;
  }

  box.innerHTML = currentTrip.destinations.map(destination => `
    <div
      class="destination-card"
      draggable="true"
      data-destination="${escapeHtml(destination.name)}"
    >
      <div class="destination-icon">
        ${getCategoryIcon(destination.category)}
      </div>

      <div class="destination-info">
        <strong>${escapeHtml(destination.name)}</strong>
        <small>${escapeHtml(destination.location || "")}</small>
      </div>

      <div class="destination-actions">
        <button
          class="destination-map"
          data-open-map="${escapeHtml(destination.name)}"
          data-map-location="${escapeHtml(destination.location || currentTrip.country || "") }"
          title="Open in Google Maps"
        >
          📍
        </button>
        <button
          class="destination-remove"
          data-remove-destination="${escapeHtml(destination.name)}"
          title="Remove destination"
        >
          ×
        </button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll("[data-remove-destination]").forEach(button => {
    button.onclick = () => {
      removeDestination(button.dataset.removeDestination);
    };
  });

  document.querySelectorAll("[data-open-map]").forEach(button => {
    button.onclick = () => {
      const destination = currentTrip.destinations.find(d => d.name.toLowerCase() === String(button.dataset.openMap).toLowerCase());
      openGoogleMapsForDestination(destination?.name || button.dataset.openMap, destination?.location || button.dataset.mapLocation || currentTrip.country || "");
      triggerDepartureReminder(destination || { name: button.dataset.openMap, location: button.dataset.mapLocation || currentTrip.country || "" });
    };
  });

  document.querySelectorAll(".destination-card").forEach(card => {

    card.addEventListener("dragstart", event => {
      event.dataTransfer.setData(
        "text/plain",
        card.dataset.destination
      );
    });

  });
}


function getCategoryIcon(category) {
  switch ((category || "").toLowerCase()) {
    case "beach":
      return "🏖";
    case "food":
    case "restaurant":
      return "🍽";
    case "activity":
      return "🎯";
    case "museum":
      return "🏛";
    case "nature":
      return "🌴";
    default:
      return "📍";
  }
}


function addDestination(destination) {
  if (!currentTrip) return;

  ensureTripStructure();

  const exists = currentTrip.destinations.some(
    d => d.name.toLowerCase() === destination.name.toLowerCase()
  );

  if (exists) return;

  currentTrip.destinations.push({
    name: destination.name,
    location: destination.location || "",
    category: destination.category || "place",
    travelMinutes: Number(destination.travelMinutes || destination.driveMinutes || destination.walkMinutes || 30)
  });

  saveCurrentTrip();
  renderDestinations();
}

function applySmartSchedule(plan = []) {
  if (!currentTrip || !Array.isArray(plan) || !plan.length) return;

  ensureTripStructure();

  plan.forEach(item => {
    if (!item || !item.name || !item.date) return;

    const destination = {
      name: item.name,
      location: item.location || "",
      category: item.category || "place",
      travelMinutes: Number(item.travelMinutes || 30)
    };

    if (!currentTrip.destinations.some(d => d.name.toLowerCase() === destination.name.toLowerCase())) {
      currentTrip.destinations.push(destination);
    }

    const key = item.date;
    if (!currentTrip.schedule[key]) {
      currentTrip.schedule[key] = [];
    }

    const nextEntry = normalizeStoredEntry({
      name: item.name,
      time: item.time || "",
      reminderMinutes: Number(item.reminderMinutes || 30),
      location: item.location || currentTrip.country || "",
      reason: item.reason || "Planned trip stop"
    });

    if (!currentTrip.schedule[key].some(dayItem => getScheduleEntryName(dayItem) === nextEntry.name.toLowerCase())) {
      currentTrip.schedule[key].push(nextEntry);
    }
  });

  saveCurrentTrip();
  renderDestinations();
  renderSchedule();
}


function removeDestination(name) {
  if (!currentTrip) return;

  currentTrip.destinations =
    currentTrip.destinations.filter(
      d => d.name.toLowerCase() !== name.toLowerCase()
    );

  DAYS.forEach(day => {
    currentTrip.schedule[day] =
      currentTrip.schedule[day].filter(
        d => getScheduleEntryName(d) !== String(name).trim().toLowerCase()
      );
  });

  saveCurrentTrip();

  renderDestinations();
  renderSchedule();
}


// ==========================================
// SCHEDULE
// ==========================================

function renderSchedule() {
  if (!currentTrip) return;

  ensureTripStructure();

  const month = getTripMonthDate(currentTrip);
  const monthDays = getCalendarMonthDays(month);
  const monthTitle = month.toLocaleString("en-US", { month: "long", year: "numeric" });
  const grid = document.getElementById("scheduleGrid");

  if (grid) {
    grid.innerHTML = monthDays.map(date => {
      const dateKey = getDateKey(date);
      const weekdayName = date.toLocaleDateString("en-US", { weekday: "long" });
      const dateItems = Array.isArray(currentTrip.schedule?.[dateKey]) ? currentTrip.schedule[dateKey] : [];
      const weekdayItems = Array.isArray(currentTrip.schedule?.[weekdayName]) ? currentTrip.schedule[weekdayName] : [];
      const mergedEntries = [...(dateItems || []), ...(weekdayItems || [])];
      const uniqueEntries = [];
      const seen = new Set();

      mergedEntries.forEach(item => {
        const label = getScheduleEntryName(item);
        if (!label || seen.has(label)) return;
        seen.add(label);
        uniqueEntries.push(normalizeStoredEntry(item));
      });

      const items = uniqueEntries;
      const isCurrentMonth = date.getMonth() === month.getMonth();
      const isTripWindow = currentTrip.startDate && currentTrip.endDate
        ? dateKey >= currentTrip.startDate && dateKey <= currentTrip.endDate
        : false;
      const isTripDay = isTripWindow && isCurrentMonth;
      const isExpanded = expandedScheduleDay === dateKey;

      const displayItems = isTripDay ? items : [];

      return `
        <div
          class="calendar-day ${isCurrentMonth ? "" : "calendar-day-muted"} ${isTripDay ? "calendar-day-trip" : ""} ${isTripDay ? "calendar-day-active" : "calendar-day-dull"} ${isExpanded ? "calendar-day-expanded" : ""}"
          data-date="${dateKey}"
        >
          <div class="calendar-day-number">${date.getDate()}</div>
          <div class="calendar-day-items">
            ${displayItems.length
              ? displayItems.map(item => {
                  const destination = currentTrip.destinations.find(d => d.name.toLowerCase() === String(item.name).toLowerCase()) || { name: item.name, location: item.location || currentTrip.country || "" };
                  const mapsUrl = buildGoogleMapsUrl(destination.name, destination.location || currentTrip.country || "");
                  const timeLabel = item.time ? `<span class="event-time">${formatScheduleTime(item.time)}</span>` : `<span class="event-time subtle">Time TBD</span>`;
                  const reminderLabel = item.reminderMinutes ? `<span class="event-reminder">${item.reminderMinutes}m reminder</span>` : "";
                  return `
                    <div class="scheduled-destination" draggable="true" data-scheduled-name="${escapeHtml(item.name)}" data-scheduled-day="${dateKey}">
                      <span>📍</span>
                      <div class="scheduled-copy">
                        <strong>${escapeHtml(item.name)}</strong>
                        ${timeLabel}
                        ${reminderLabel ? `<small>${reminderLabel}</small>` : ""}
                      </div>
                      <div class="event-actions">
                        <a class="event-map-link" href="${mapsUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHtml(item.name)} in Google Maps">Map</a>
                        <button class="set-time-btn" data-time-name="${escapeHtml(item.name)}" data-time-day="${dateKey}" title="Set time">⏰</button>
                        <button data-remove-scheduled="${escapeHtml(item.name)}" data-remove-day="${dateKey}">×</button>
                      </div>
                    </div>
                  `;
                }).join("")
              : (isTripDay ? '<span class="calendar-empty">Open</span>' : '<span class="calendar-empty calendar-empty-dim">Off trip</span>')}
          </div>
        </div>
      `;
    }).join("");
  }

  const calendarHeader = document.getElementById("calendarHeader");
  if (calendarHeader) {
    calendarHeader.textContent = monthTitle;
  }

  const tripMeta = document.getElementById("tripDateRange");
  const homeMeta = document.getElementById("tripHotelLocation");

  if (tripMeta) {
    tripMeta.textContent = formatTripDateRange(currentTrip);
  }

  if (homeMeta) {
    const hotelName = currentTrip.homePoint?.hotel || currentTrip.hotel || "Home base not set";
    const countryName = currentTrip.homePoint?.country || currentTrip.country || "Country not set";
    homeMeta.textContent = `${hotelName} • ${countryName}`;
  }

  renderTripManagementPrompt();

  document.querySelectorAll("[data-remove-scheduled]").forEach(button => {
    button.onclick = () => {
      removeFromDay(button.dataset.removeDay, button.dataset.removeScheduled);
    };
  });

  document.querySelectorAll("[data-time-name]").forEach(button => {
    button.onclick = () => {
      setScheduleTimeForDay(button.dataset.timeDay, button.dataset.timeName);
    };
  });

  const timeEditor = document.getElementById("closeTimeEditor");
  const cancelTimeEditor = document.getElementById("cancelTimeEditor");
  const saveTimeEditor = document.getElementById("saveTimeEditor");

  if (timeEditor) {
    timeEditor.onclick = closeScheduleTimeEditor;
  }

  if (cancelTimeEditor) {
    cancelTimeEditor.onclick = closeScheduleTimeEditor;
  }

  if (saveTimeEditor) {
    saveTimeEditor.onclick = saveScheduleTimeEditor;
  }

  document.querySelectorAll(".event-map-link").forEach(link => {
    link.onclick = event => {
      event.preventDefault();
      window.open(link.getAttribute("href"), "_blank", "noopener,noreferrer");
    };
  });

  document.querySelectorAll(".calendar-day").forEach(cell => {
    cell.ondragover = event => event.preventDefault();
    cell.ondrop = event => {
      event.preventDefault();
      const name = event.dataTransfer.getData("text/plain");
      if (name) {
        addToDay(cell.dataset.date, name);
      }
    };
    cell.onclick = event => {
      if (event.target.closest("button, a")) return;
      if (!cell.dataset.date) return;
      expandedScheduleDay = expandedScheduleDay === cell.dataset.date ? null : cell.dataset.date;
      renderSchedule();
    };
  });

  scheduleTimedReminders();
}


function addToDay(day, name) {
  if (!currentTrip) return;

  ensureTripStructure();

  const destinationExists = currentTrip.destinations.some(
    d => d.name.toLowerCase() === name.toLowerCase()
  );

  if (!destinationExists) return;

  const startDate = currentTrip.startDate || currentTrip.tripDates?.startDate;
  const endDate = currentTrip.endDate || currentTrip.tripDates?.endDate;

  const entry = normalizeStoredEntry({
    name,
    time: "",
    reminderMinutes: 30,
    reason: "Planned stop"
  });

  if (startDate && endDate) {
    const matches = [];
    const rawDay = String(day || "").trim();
    const normalizedDay = rawDay.includes("-") ? new Date(`${rawDay}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" }) : rawDay;
    const normalizedTarget = normalizedDay;
    const dayIndex = DAYS.indexOf(normalizedTarget);

    if (dayIndex !== -1) {
      const start = new Date(`${startDate}T12:00:00`);
      const end = new Date(`${endDate}T12:00:00`);
      const cursor = new Date(start);

      while (cursor <= end) {
        if (cursor.getDay() === ((dayIndex + 1) % 7)) {
          matches.push(cursor.toISOString().slice(0, 10));
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    if (matches.length > 1) {
      const options = matches
        .map(date => `${date} (${new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })})`)
        .join(", ");

      const chosen = window.prompt(
        `Your trip spans multiple ${normalizedTarget}s. Which one do you want to add ${name} to? Choose one of these dates: ${options}`
      );

      if (!chosen) return;

      const chosenDate = chosen.trim().split(" ")[0];
      const targetDate = chosenDate || matches[0];

      if (!currentTrip.schedule[targetDate]) {
        currentTrip.schedule[targetDate] = [];
      }

      if (!currentTrip.schedule[targetDate].some(item => normalizeStoredEntry(item).name.toLowerCase() === entry.name.toLowerCase())) {
        currentTrip.schedule[targetDate].push(entry);
      }

      saveCurrentTrip();
      renderSchedule();
      return;
    }
  }

  const resolvedKey = resolveTripDayKey(day, currentTrip) || day;
  const weekdayName = !resolvedKey.includes("-") ? resolvedKey : new Date(`${resolvedKey}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });

  const keys = [...new Set([resolvedKey, weekdayName])].filter(Boolean);

  keys.forEach(key => {
    if (!currentTrip.schedule[key]) {
      currentTrip.schedule[key] = [];
    }

    if (!currentTrip.schedule[key].some(item => normalizeStoredEntry(item).name.toLowerCase() === entry.name.toLowerCase())) {
      currentTrip.schedule[key].push(entry);
    }
  });

  saveCurrentTrip();
  renderSchedule();
}


function removeFromDay(day, name) {
  if (!currentTrip) return;

  const resolvedKey = resolveTripDayKey(day, currentTrip) || day;
  const weekdayName = !resolvedKey.includes("-") ? resolvedKey : new Date(`${resolvedKey}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
  const keys = [...new Set([resolvedKey, weekdayName, day])].filter(Boolean);

  keys.forEach(key => {
    if (!currentTrip.schedule[key]) {
      currentTrip.schedule[key] = [];
    }

    currentTrip.schedule[key] = currentTrip.schedule[key].filter(
      d => normalizeStoredEntry(d).name.toLowerCase() !== String(name).toLowerCase()
    );
  });

  saveCurrentTrip();
  renderSchedule();
}


function moveDestination(fromDay, toDay, name) {
  removeFromDay(fromDay, name);
  addToDay(toDay, name);
}


function clearDay(day) {
  if (!currentTrip) return;

  currentTrip.schedule[day] = [];

  saveCurrentTrip();
  renderSchedule();
}


function clearSchedule() {
  if (!currentTrip) return;

  Object.keys(currentTrip.schedule).forEach(key => {
    currentTrip.schedule[key] = [];
  });

  saveCurrentTrip();
  renderSchedule();
}


// ==========================================
// APPLY AI ACTIONS
// ==========================================

function applyAIActions(actions) {

  if (!currentTrip || !Array.isArray(actions)) return;

  ensureTripStructure();

  actions.forEach(action => {

    if (!action || !action.type) return;

    switch (action.type) {

      case "SET_HOTEL":

        currentTrip.hotel = action.hotel || "";

        if (action.country) {
          currentTrip.country = action.country;
        }

        break;


      case "ADD_DESTINATION":

        if (action.destination && action.destination.name) {
          addDestination(action.destination);
        }

        break;


      case "REMOVE_DESTINATION":

        if (action.name) {
          removeDestination(action.name);
        }

        break;


      case "ADD_TO_DAY":

        if (action.day && action.name) {
          addToDay(action.day, action.name);
        }

        break;


      case "REMOVE_FROM_DAY":

        if (action.day && action.name) {
          removeFromDay(action.day, action.name);
        }

        break;


      case "MOVE_DESTINATION":

        if (
          action.fromDay &&
          action.toDay &&
          action.name
        ) {
          moveDestination(
            action.fromDay,
            action.toDay,
            action.name
          );
        }

        break;


      case "CLEAR_DAY":

        if (action.day) {
          clearDay(action.day);
        }

        break;


      case "CLEAR_SCHEDULE":

        clearSchedule();

        break;

      case "SMART_SCHEDULE":

        if (Array.isArray(action.plan)) {
          applySmartSchedule(action.plan);
        }

        break;

      case "SET_SCHEDULE_TIME":
        if (action.day && action.name) {
          const entry = normalizeStoredEntry(
            currentTrip.schedule?.[action.day]?.find(item => normalizeStoredEntry(item).name.toLowerCase() === String(action.name).toLowerCase())
          );

          const nextEntry = {
            ...entry,
            time: action.time || entry.time || "",
            reminderMinutes: Number(action.reminderMinutes ?? entry.reminderMinutes ?? 30),
            reason: action.reason || entry.reason || `Planned stop for ${action.name}.`
          };

          currentTrip.schedule[action.day] = (currentTrip.schedule[action.day] || []).map(item => {
            const normalized = normalizeStoredEntry(item);
            return normalized.name.toLowerCase() === String(action.name).toLowerCase() ? nextEntry : item;
          });
        }

        break;
    }
  });

  saveCurrentTrip();

  renderDestinations();
  renderSchedule();
}


// ==========================================
// CHAT
// ==========================================

function syncPlannerContextFromMessage(text) {
  if (!currentTrip || !text) return "";

  ensureTripStructure();

  const context = inferTripContext(text);

  if (context.hotel) {
    currentTrip.hotel = context.hotel;
    currentTrip.homePoint = currentTrip.homePoint || {};
    currentTrip.homePoint.hotel = context.hotel;
  }

  if (context.stayLocation) {
    currentTrip.country = context.stayLocation;
    currentTrip.homePoint = currentTrip.homePoint || {};
    currentTrip.homePoint.country = context.stayLocation;
  }

  if (context.stayLengthDays) {
    currentTrip.stayLengthDays = context.stayLengthDays;
  }

  if (context.tripDates?.startDate) {
    currentTrip.startDate = context.tripDates.startDate;
    currentTrip.endDate = context.tripDates.endDate || context.tripDates.startDate;
  }

  if (context.day && context.activityGoals.length) {
    currentTrip.schedule = assignActivityToDay(
      currentTrip.schedule,
      context.day,
      context.activityGoals
    );
  }

  saveCurrentTrip();
  renderDestinations();
  renderSchedule();

  return buildFollowUpQuestion({
    hotel: currentTrip.hotel,
    stayLocation: currentTrip.country,
    stayLengthDays: currentTrip.stayLengthDays,
    activityGoals: context.activityGoals
  });
}


function addUserMessage(text, persist = true) {
  const chatWindow = $("chatWindow");

  if (persist && currentTrip) {
    currentTrip.chatHistory = currentTrip.chatHistory || [];
    currentTrip.chatHistory.push({ type: "user", text });
    saveCurrentTrip();
  }

  chatWindow.insertAdjacentHTML(
    "beforeend",
    `
      <div class="message user-message">
        <div class="user-message-bubble">
          <p>${escapeHtml(text)}</p>
        </div>
      </div>
    `
  );

  chatWindow.scrollTop =
    chatWindow.scrollHeight;
}


function addAIMessage(text, persist = true, suggestions = []) {
  const chatWindow = $("chatWindow");
  const normalizedText = String(text || "").trim();

  if (!normalizedText) return;

  const lastAiMessage = chatWindow?.querySelector(".message.ai-message:last-child p");
  if (lastAiMessage && lastAiMessage.textContent.trim() === normalizedText) {
    return;
  }

  if (persist && currentTrip) {
    currentTrip.chatHistory = currentTrip.chatHistory || [];
    currentTrip.chatHistory.push({ type: "ai", text: normalizedText });
    saveCurrentTrip();
  }

  const wrapper = document.createElement("div");
  wrapper.className = "message ai-message";

  wrapper.innerHTML = `
    <div class="message-avatar">JR</div>

    <div>
      <div class="message-name">
        Roamly.Jr.
      </div>

      <p>
        ${escapeHtml(text).replace(/\n/g, "<br>")}
      </p>
    </div>
  `;

  chatWindow.appendChild(wrapper);

  if (Array.isArray(suggestions) && suggestions.length) {
    const row = document.createElement("div");
    row.className = "suggestion-row";

    suggestions.forEach(suggestion => {
      const label = suggestion?.label || suggestion?.value || "Continue";
      const value = suggestion?.value || label;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion-chip";
      button.textContent = label;
      button.dataset.prompt = value;
      button.onclick = () => {
        const chatInput = $("chatInput");
        if (chatInput) {
          chatInput.value = value;
          sendChat();
        }
      };
      row.appendChild(button);
    });

    chatWindow.appendChild(row);
  }

  chatWindow.scrollTop = chatWindow.scrollHeight;
}


function addThinkingMessage() {
  $("chatWindow").insertAdjacentHTML(
    "beforeend",
    `
      <div class="message ai-message" id="roamlyThinking">
        <div class="message-avatar">JR</div>

        <div>
          <div class="message-name">
            Roamly.Jr.
          </div>

          <p>Thinking...</p>
        </div>
      </div>
    `
  );

  $("chatWindow").scrollTop =
    $("chatWindow").scrollHeight;
}


function removeThinkingMessage() {
  const element = $("roamlyThinking");

  if (element) {
    element.remove();
  }
}


// ==========================================
// SEND MESSAGE
// ==========================================

async function sendChat() {

  if (!currentUser || !currentUser.email) {
    showMascotWalkthrough();
    return;
  }

  const input = $("chatInput");

  if (!input) return;

  const text = input.value.trim();

  if (!text) return;

  addUserMessage(text);

  syncPlannerContextFromMessage(text);

  if (text.toLowerCase().includes('remember') || text.toLowerCase().includes('recall')) {
    const memorySummary = currentTrip
      ? `Trip memory: ${currentTrip.hotel || 'hotel not set'} in ${currentTrip.country || 'location not set'} from ${currentTrip.startDate || 'a date not set'} to ${currentTrip.endDate || 'end date not set'}.`
      : 'No trip memory saved yet.';

    addAIMessage(memorySummary);
    input.value = "";
    return;
  }

  input.value = "";

  addThinkingMessage();

  try {

    ensureTripStructure();

    const scheduleData = buildScheduleDataForRequest();

    const response = await fetch(
      "/api/roamly-jr",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          message: text,
          scheduleData,
          userEmail: currentUser?.email || null
        })
      }
    );

    const data = await response.json();

    removeThinkingMessage();

    if (!response.ok || !data.success) {
      const errorMessage = data.error || "Roamly Jr. could not respond.";

      if (response.status === 429 || /free version|usage limit|limit.*Gemini/i.test(errorMessage)) {
        showUsageLimitModal(
          "Roamly.Jr. is temporarily unavailable. Please try again in a moment."
        );
      }

      throw new Error(errorMessage);
    }

    // ACTUALLY CHANGE THE TRIP
    applyAIActions(data.actions);

    if (Array.isArray(data.research) && data.research.length) {
      const researchText = data.research.map(item => `• ${item.name} — ${item.summary || item.location || item.category || 'recommended for your trip'}`).join('\n');
      addAIMessage(`${data.reply}\n\n${researchText}`, true, data.suggestions || []);
    } else {
      // THEN SHOW AI RESPONSE
      addAIMessage(data.reply, true, data.suggestions || []);
    }

  } catch (error) {

    console.error("Roamly Jr. error:", error);

    removeThinkingMessage();

    addAIMessage(
      error.message ||
      "Sorry, I couldn't connect to Roamly Jr."
    );
  }
}


// ==========================================
// BUTTONS
// ==========================================

$("sendBtn").onclick = sendChat;

$("chatInput").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    sendChat();
  }
});


document.querySelectorAll(".quick-actions button").forEach(button => {

  button.onclick = () => {

    $("chatInput").value =
      button.textContent
        .replace(/^[^ ]+ /, "")
        .trim();

    sendChat();
  };

});

const timeEditorInput = document.getElementById("scheduleTimeInput");
if (timeEditorInput) {
  timeEditorInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      saveScheduleTimeEditor();
    }
  });
}


// ==========================================
// MODALS
// ==========================================

$("newTripBtn").onclick = () => {
  $("newTripModal").classList.remove("hidden");

  if (!currentUser && $("mascotOnboarding") && !$("mascotOnboarding").classList.contains("hidden") && !onboardingPausedForCreate) {
    hideMascotWalkthrough();
    setTimeout(() => {
      const nameInput = $("tripName");
      if (nameInput) {
        nameInput.focus();
      }
    }, 120);
  }
};

$("closeModal").onclick = () => {
  $("newTripModal").classList.add("hidden");
};

$("continueBtn").onclick = () => {
  trips.length
    ? openTrips()
    : $("newTripModal").classList.remove("hidden");
};

$("closeTrips").onclick = () => {
  $("tripModal").classList.add("hidden");
};

$("closeUsageLimit").onclick = hideUsageLimitModal;
$("usageLimitOk").onclick = hideUsageLimitModal;

$("createTrip").onclick = createTrip;

$("tripName").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    createTrip();
  }
});


// ==========================================
// TABS
// ==========================================

document.querySelectorAll(".side-btn[data-tab]").forEach(button => {

  button.onclick = () => {

    document.querySelectorAll(".side-btn").forEach(b => {
      b.classList.remove("active");
    });

    button.classList.add("active");

    const chat = button.dataset.tab === "chat";

    $("chatPanel").classList.toggle(
      "hidden",
      !chat
    );

    $("schedulePanel").classList.toggle(
      "hidden",
      chat
    );

    $("sectionEyebrow").textContent =
      chat
        ? "AI TRAVEL ASSISTANT"
        : "TRIP ORGANIZER";

    $("sectionTitle").textContent =
      chat
        ? "Roamly.Jr."
        : "Schedule";
  };

});


// ==========================================
// RESET
// ==========================================

$("resetTrip").onclick = () => {

  if (!currentTrip) return;

  if (
    confirm(
      "Reset this trip? The saved trip will be removed from this device."
    )
  ) {

    trips = trips.filter(
      trip => trip.id !== currentTrip.id
    );

    saveTrips();

    location.reload();
  }
};


// ==========================================
// SMART PLAN
// ==========================================

$("smartPlanBtn").onclick = () => {

  document
    .querySelector('[data-tab="chat"]')
    .click();

  $("chatInput").value =
    "Create a smart plan for my entire trip using all of my destinations.";

  sendChat();
};


// ==========================================
// STARTUP
// ==========================================

function showAuthModal(mode = "signup", promptText = "") {
  const modal = $("authModal");
  const title = $("authTitle");
  const form = $("authForm");
  const nameWrap = $("authNameWrap");
  const submitBtn = $("authSubmitBtn");
  const message = $("authMessage");
  const tabs = document.querySelectorAll(".auth-tab");

  if (!modal) return;

  tabs.forEach(tab => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle("active", active);
  });

  if (title) {
    title.textContent = mode === "login" ? "Log in to Roamly" : "Create your account";
  }

  if (nameWrap) {
    nameWrap.style.display = mode === "login" ? "none" : "flex";
  }

  if (submitBtn) {
    submitBtn.textContent = mode === "login" ? "Log in" : "Create account";
  }

  if (message) {
    const defaultMessage = mode === "login"
      ? "Welcome back — sign in to continue planning your trip."
      : "Create your account to keep using Roamly and continue where you left off.";
    message.textContent = promptText || defaultMessage;
  }

  if (form) {
    form.reset();
  }

  modal.classList.remove("hidden");
}

function hideAuthModal() {
  const modal = $("authModal");
  if (modal) {
    modal.classList.add("hidden");
  }
}

function redirectGuestToAuth(event) {
  if (currentUser || !onboardingInterrupted) return false;

  const target = event && event.target ? event.target : null;
  const insideAuth = target && target.closest
    ? target.closest("#authModal, .auth-card, .auth-tab, #authForm, #authSubmitBtn, #closeAuthModal")
    : false;

  if (insideAuth) return false;

  hideMascotWalkthrough();
  showAuthModal("signup", "Your trip is waiting. Create your account to keep planning and continue where you left off.");

  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  return true;
}

function resetAnonymousGuestState() {
  currentTrip = null;
  const homeView = $("homeView");
  const plannerView = $("plannerView");

  if (homeView) homeView.classList.remove("hidden");
  if (plannerView) plannerView.classList.add("hidden");

  onboardingInterrupted = false;
  hideAuthModal();
  hideMascotWalkthrough();
  showMascotWalkthrough();
}

function setTourPosition(targetSelector, offsetX = 0, offsetY = 0) {
  const highlight = $("tourHighlight");
  const pointer = $("tourPointer");
  const target = targetSelector ? document.querySelector(targetSelector) : null;

  if (!highlight || !pointer) return;

  if (!target) {
    highlight.style.opacity = "0";
    pointer.style.opacity = "0";
    return;
  }

<<<<<<< HEAD
  const rect = target.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2 + offsetX;
  const centerY = rect.top + rect.height / 2 + offsetY;

  highlight.style.width = `${Math.max(rect.width + 34, 110)}px`;
  highlight.style.height = `${Math.max(rect.height + 34, 110)}px`;
=======
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const isMobile = viewportWidth <= 768;

  const rect = target.getBoundingClientRect();
  let centerX = rect.left + rect.width / 2 + offsetX;
  let centerY = rect.top + rect.height / 2 + offsetY;

  if (isMobile) {
    centerX = Math.min(Math.max(centerX, 75), viewportWidth - 75);
    centerY = Math.min(Math.max(centerY, 110), viewportHeight - 130);
  }

  const highlightPadding = isMobile ? 16 : 34;
  const highlightSize = Math.max(rect.width + highlightPadding, isMobile ? 90 : 110);

  highlight.style.width = `${highlightSize}px`;
  highlight.style.height = `${highlightSize}px`;
>>>>>>> 3d98f55 (Production polish + mobile onboarding pass)
  highlight.style.left = `${centerX}px`;
  highlight.style.top = `${centerY}px`;
  highlight.style.opacity = "1";
  highlight.style.transform = "translate(-50%, -50%) scale(1)";

  pointer.style.left = `${centerX}px`;
  pointer.style.top = `${centerY}px`;
  pointer.style.opacity = "1";
}

function getFrontPageTourSteps() {
  return [
    {
      message: "Welcome to Roamly Schedule. First, click Create New Trip so we can build your itinerary together.",
      target: "#newTripBtn",
      buttonText: "Next",
      action: () => {
        onboardingPausedForCreate = true;
        hideMascotWalkthrough();
        if (!$("homeView")?.classList.contains("hidden")) {
          $("newTripBtn")?.focus();
        }
      }
    },
    {
      message: "Now type a trip name and click Create Trip. I’ll wait here while you do it.",
      target: "#tripName",
      buttonText: "Next",
      action: () => {
        const nameInput = $("tripName");
        if (nameInput) {
          nameInput.focus();
          if (!nameInput.value.trim()) {
            nameInput.placeholder = "e.g. Curaçao Summer Trip";
          }
        }
      }
    },
    {
      message: buildTripCreatedGuidance(currentTrip?.name || "your trip"),
      target: "#currentTripName",
      buttonText: "Next",
      action: () => {
        const chatTab = document.querySelector('[data-tab="chat"]');
        if (chatTab) {
          chatTab.click();
        }
      }
    },
    {
      message: "When you are ready, click the chat assistant, type a request, and I’ll help you build the trip. Then we’ll finish by logging in.",
      target: "#chatInput",
      buttonText: "Log in",
      action: () => {
        if (!$("chatInput")) return;
        $("chatInput").focus();
        $("chatInput").value = "Plan my trip to Curaçao";
      }
    },
    {
      message: "To use Roamly Schedule, you need to log in first.",
      target: "#loginBtn",
      buttonText: "Log in",
      action: () => {
        $("loginBtn")?.click();
      }
    }
  ];
}

function redirectToSignupIfIgnored() {
  if (!currentUser && $("mascotOnboarding") && !$("mascotOnboarding").classList.contains("hidden")) {
    onboardingInterrupted = true;
    hideMascotWalkthrough();
    showAuthModal("signup");
  }
}

function startOnboardingFallbackTimer() {
  if (onboardingFallbackTimer) {
    clearTimeout(onboardingFallbackTimer);
  }

  onboardingFallbackTimer = setTimeout(() => {
    if (!currentUser) {
      redirectToSignupIfIgnored();
    }
  }, 18000);
}

function showMascotWalkthrough(startStep = 0) {
  if (onboardingInterrupted) return;

  const overlay = $("mascotOnboarding");
  const bubble = $("mascotBubble");
  const nextBtn = $("nextMascotBubble");
  const prevBtn = $("prevMascotBubble");

  if (!overlay || !bubble) return;

  const shouldKeepTripVisible = Boolean(currentTrip) && !$("homeView")?.classList.contains("hidden");

  if (!currentUser && !currentTrip && !shouldKeepTripVisible) {
    currentTrip = null;
    goToFrontPage();
  }

  if (currentTrip && $("plannerView")) {
    $("homeView")?.classList.add("hidden");
    $("plannerView").classList.remove("hidden");
  }

  onboardingSteps = getFrontPageTourSteps();
  currentOnboardingStep = Number.isInteger(startStep) ? startStep : 0;
  if (currentOnboardingStep >= onboardingSteps.length) {
    currentOnboardingStep = onboardingSteps.length - 1;
  }
  bubble.textContent = onboardingSteps[currentOnboardingStep].message;

  if (nextBtn) {
    nextBtn.textContent = onboardingSteps[currentOnboardingStep].buttonText || "Next";
  }

  if (prevBtn) {
    prevBtn.classList.toggle("hidden", currentOnboardingStep === 0);
  }

  overlay.classList.remove("hidden");
  setTourPosition(onboardingSteps[currentOnboardingStep].target, 0, 0);
  startOnboardingFallbackTimer();
}

function hideMascotWalkthrough() {
  const overlay = $("mascotOnboarding");
  const highlight = $("tourHighlight");
  const pointer = $("tourPointer");

  if (onboardingFallbackTimer) {
    clearTimeout(onboardingFallbackTimer);
    onboardingFallbackTimer = null;
  }

  if (highlight) highlight.style.opacity = "0";
  if (pointer) pointer.style.opacity = "0";

  if (overlay) {
    overlay.classList.add("hidden");
  }
}

function skipMascotWalkthrough() {
  onboardingInterrupted = true;
  hideMascotWalkthrough();
  showAuthModal("signup", "Skip the guide and create your account to unlock Roamly and keep your trip moving.");
}

function advanceMascotWalkthrough() {
  const bubble = $("mascotBubble");
  const nextBtn = $("nextMascotBubble");
  const prevBtn = $("prevMascotBubble");

  if (!bubble || !onboardingSteps.length) return;

  currentOnboardingStep += 1;

  if (currentOnboardingStep >= onboardingSteps.length) {
    hideMascotWalkthrough();
    return;
  }

  const step = onboardingSteps[currentOnboardingStep];
  bubble.textContent = step.message;

  if (nextBtn) {
    nextBtn.textContent = step.buttonText || "Next";
  }

  if (prevBtn) {
    prevBtn.classList.toggle("hidden", currentOnboardingStep === 0);
  }

  setTourPosition(step.target, 0, 0);
  if (step.action) {
    setTimeout(() => step.action(), 220);
  }
}

function resumeMascotWalkthroughAfterAction() {
  const overlay = $("mascotOnboarding");
  if (overlay) {
    overlay.classList.remove("paused");
  }

  if (currentOnboardingStep >= onboardingSteps.length - 1) {
    hideMascotWalkthrough();
    return;
  }

  const step = onboardingSteps[currentOnboardingStep + 1];
  if (step) {
    $("mascotBubble").textContent = step.message;
    $("nextMascotBubble").textContent = step.buttonText || "Next";
    setTourPosition(step.target, 0, 0);
    startOnboardingFallbackTimer();
  }
}

function updateAuthUi() {
  const status = $("authStatus");
  const loginBtn = $("loginBtn");
  const logoutBtn = $("logoutBtn");

  if (status) {
    const label = currentUser && currentUser.email
      ? `SIGNED IN: ${currentUser.email}`
      : "SYSTEM READY";

    status.innerHTML = `<i></i>${escapeHtml(label)}`;
  }

  if (loginBtn) {
    loginBtn.classList.toggle("hidden", Boolean(currentUser));
  }

  if (logoutBtn) {
    logoutBtn.classList.toggle("hidden", !currentUser);
  }
}

function requireLoginForAction() {
  if (!currentUser || !currentUser.email) {
    showMascotWalkthrough();
    return false;
  }
  return true;
}

function goToFrontPage() {
  const homeView = $("homeView");
  const plannerView = $("plannerView");

  if (homeView) homeView.classList.remove("hidden");
  if (plannerView) plannerView.classList.add("hidden");

  if (currentTrip) {
    const currentTripName = $("currentTripName");
    const scheduleTitle = $("scheduleTitle");

    if (currentTripName) currentTripName.textContent = currentTrip.name;
    if (scheduleTitle) scheduleTitle.textContent = currentTrip.name;
  }
}

function applyUserLocation(location) {
  if (!location) return;

  appUserLocation = location;

  if (currentTrip) {
    currentTrip.userLocation = location;

    if (!currentTrip.homePoint) {
      currentTrip.homePoint = {};
    }

    currentTrip.homePoint.currentLocation = {
      lat: location.lat,
      lng: location.lng,
      label: location.label
    };

    saveCurrentTrip();
    renderSchedule();
  }
}

function buildScheduleDataForRequest() {
  const baseTrip = currentTrip ? { ...currentTrip } : {};

  if (appUserLocation) {
    baseTrip.userLocation = appUserLocation;

    if (!baseTrip.homePoint) {
      baseTrip.homePoint = {};
    }

    baseTrip.homePoint.currentLocation = {
      lat: appUserLocation.lat,
      lng: appUserLocation.lng,
      label: appUserLocation.label
    };
  }

  return baseTrip;
}

function requestUserLocation() {
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    position => {
      const location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy || 0,
        source: "device",
        label: `${position.coords.latitude.toFixed(4)}, ${position.coords.longitude.toFixed(4)}`
      };

      applyUserLocation(location);
    },
    () => {
      // No location access; keep hotel/trip location authoritative.
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 600000
    }
  );
}

function initializeSavedTrip() {
  if (!trips.length) return null;

  currentTrip = restoreLastTripReference();

  if (!currentTrip) return null;

  ensureTripStructure();

  const homeView = $("homeView");
  const plannerView = $("plannerView");

  if (homeView) homeView.classList.add("hidden");
  if (plannerView) plannerView.classList.remove("hidden");

  const currentTripName = $("currentTripName");
  const scheduleTitle = $("scheduleTitle");

  if (currentTripName) currentTripName.textContent = currentTrip.name;
  if (scheduleTitle) scheduleTitle.textContent = currentTrip.name;

  restoreChatHistory();
  renderDestinations();
  renderSchedule();

  return currentTrip;
}

function handleGoogleCredentialResponse(response) {
  try {
    const payload = JSON.parse(atob(response.credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const email = String(payload.email || "").trim();

    if (!email) {
      return;
    }

    const users = readUsers();
    const normalizedEmail = normalizeEmail(email);
    if (!users[normalizedEmail]) {
      users[normalizedEmail] = {
        name: payload.name || payload.given_name || "Google User",
        email: normalizedEmail,
        password: "google-oauth"
      };
      writeUsers(users);
    }

    saveCurrentUser({ email: normalizedEmail, name: payload.name || payload.given_name || "Google User" });
    hideMascotWalkthrough();
    hideAuthModal();
  } catch (error) {
    console.error("Google sign-in failed:", error);
  }
}

function handleAuthSubmit(event) {
  event.preventDefault();

  const mode = document.querySelector(".auth-tab.active")?.dataset.authMode || "signup";
  const name = $("authName")?.value || "";
  const email = $("authEmail")?.value || "";
  const password = $("authPassword")?.value || "";
  const message = $("authMessage");

  if (!message) return;

  if (mode === "login") {
    const result = loginWithEmail(email, password);
    message.textContent = result.message;

    if (result.ok) {
      hideAuthModal();
      hideMascotWalkthrough();
      goToFrontPage();
    }
    return;
  }

  const result = createAccount(name, email, password);
  message.textContent = result.message;

  if (result.ok) {
    hideAuthModal();
    hideMascotWalkthrough();
    goToFrontPage();
  }
}

async function initializeGoogleAuth() {
  const configResult = await fetch("/api/auth/config")
    .then(response => response.ok ? response.json() : { googleClientId: null })
    .catch(() => ({ googleClientId: null }));

  const clientId = configResult.googleClientId || null;

  if (clientId && window.google?.accounts?.id) {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: handleGoogleCredentialResponse
    });

    window.google.accounts.id.renderButton($("gmailLoginBtn"), {
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill"
    });
  }
}

renderSavedTrips();
updateAuthUi();

if (!currentUser) {
  resetAnonymousGuestState();
} else {
  const resumedTrip = initializeSavedTrip();

  if (!resumedTrip) {
    goToFrontPage();
  }
}

$("frontPageBtn").onclick = goToFrontPage;
$("loginBtn").onclick = () => showAuthModal("signup");
$("logoutBtn").onclick = () => {
  saveCurrentUser(null);
  currentTrip = null;
  onboardingInterrupted = false;
  showMascotWalkthrough();
  goToFrontPage();
};
$("closeAuthModal").onclick = hideAuthModal;
$("authForm").onsubmit = handleAuthSubmit;
$("gmailLoginBtn").onclick = () => {
  if (window.google?.accounts?.id) {
    window.google.accounts.id.prompt();
  }
};
document.querySelectorAll(".auth-tab").forEach(tab => {
  tab.onclick = () => {
    const mode = tab.dataset.authMode || "signup";
    showAuthModal(mode);
  };
});
$("nextMascotBubble").onclick = () => {
  const step = onboardingSteps[currentOnboardingStep];

  if (step?.action) {
    step.action();
  }

  if (currentOnboardingStep >= onboardingSteps.length - 1) {
    onboardingInterrupted = true;
    hideMascotWalkthrough();
    if (!currentUser) {
      showAuthModal("signup", "You’re almost ready — sign up to keep using Roamly and continue your trip without losing progress.");
    }
    return;
  }

  setTimeout(() => advanceMascotWalkthrough(), 250);
  startOnboardingFallbackTimer();
};
$("skipMascotBubble").onclick = () => {
  skipMascotWalkthrough();
};
$("prevMascotBubble").onclick = () => {
  if (currentOnboardingStep > 0) {
    currentOnboardingStep -= 1;
    const step = onboardingSteps[currentOnboardingStep];
    $("mascotBubble").textContent = step.message;
    $("nextMascotBubble").textContent = step.buttonText || "Next";
    $("prevMascotBubble").classList.toggle("hidden", currentOnboardingStep === 0);
    setTourPosition(step.target, 0, 0);
    startOnboardingFallbackTimer();
  }
};
$("mascotOnboarding").onclick = event => {
  if (event.target === $("mascotOnboarding")) {
    hideMascotWalkthrough();
  }
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden && !currentUser) {
    redirectToSignupIfIgnored();
  }
});

window.addEventListener("blur", () => {
  if (!currentUser && $("mascotOnboarding") && !$("mascotOnboarding").classList.contains("hidden")) {
    redirectToSignupIfIgnored();
  }
});
<<<<<<< HEAD
=======

window.addEventListener("resize", () => {
  if (!currentUser && $("mascotOnboarding") && !$("mascotOnboarding").classList.contains("hidden")) {
    const step = onboardingSteps[currentOnboardingStep];
    if (step) {
      setTourPosition(step.target, 0, 0);
    }
  }
});
>>>>>>> 3d98f55 (Production polish + mobile onboarding pass)

document.addEventListener("click", event => {
  redirectGuestToAuth(event);
}, true);