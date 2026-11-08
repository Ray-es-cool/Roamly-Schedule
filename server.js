import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
    inferTripContext,
    buildFollowUpQuestion,
    assignActivityToDay,
    rankPlaces
} from "./scheduler-logic.js";

dotenv.config({ override: true });

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const tripsFile = path.join(dataDir, "roamly-trips.json");
const usageFile = path.join(dataDir, "roamly-usage.json");
const DAILY_MESSAGE_LIMIT = 25;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function readTripStore() {
    try {
        const raw = fs.readFileSync(tripsFile, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

function writeTripStore(store) {
    fs.writeFileSync(tripsFile, JSON.stringify(store, null, 2));
}

function getUserTrips(userId) {
    if (!userId) return [];

    const store = readTripStore();
    const userTrips = Array.isArray(store[String(userId)]) ? store[String(userId)] : [];

    return userTrips.filter(trip => trip && typeof trip === "object");
}

function setUserTrips(userId, trips) {
    if (!userId) return;

    const store = readTripStore();
    const safeTrips = Array.isArray(trips) ? trips.filter(trip => trip && typeof trip === "object") : [];

    store[String(userId)] = safeTrips.map(trip => ({
        ...trip,
        id: String(trip.id || crypto.randomUUID())
    }));

    writeTripStore(store);
}

function readUsageStore() {
    try {
        const raw = fs.readFileSync(usageFile, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

function writeUsageStore(store) {
    fs.writeFileSync(usageFile, JSON.stringify(store, null, 2));
}

function normalizeEmail(email = "") {
    return String(email || "").trim().toLowerCase();
}

function getCurrentUsageDayKey() {
    return new Date().toISOString().slice(0, 10);
}

function getUserDailyMessageCount(userEmail) {
    const email = normalizeEmail(userEmail);
    if (!email) return 0;

    const store = readUsageStore();
    const dayKey = getCurrentUsageDayKey();
    const userEntries = store[email] && typeof store[email] === "object" ? store[email] : {};
    return Number(userEntries[dayKey] || 0);
}

function incrementUserDailyMessageCount(userEmail) {
    const email = normalizeEmail(userEmail);
    if (!email) return 0;

    const store = readUsageStore();
    const dayKey = getCurrentUsageDayKey();
    const userEntries = store[email] && typeof store[email] === "object" ? store[email] : {};
    const nextCount = Number(userEntries[dayKey] || 0) + 1;
    store[email] = { ...userEntries, [dayKey]: nextCount };
    writeUsageStore(store);
    return nextCount;
}

const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
const foursquareApiKey = process.env.FOURSQUARE_API_KEY?.trim();
const ai = geminiApiKey
    ? new GoogleGenAI({ apiKey: geminiApiKey })
    : null;

async function searchFoursquarePlaces(query, location = "", coordinates = null) {
    if (!foursquareApiKey) {
        return [];
    }

    const queryText = [query, location].filter(Boolean).join(" in ");

    try {
        const params = new URLSearchParams({
            query: query || "popular places",
            limit: "3"
        });

        if (coordinates && Number.isFinite(coordinates.lat) && Number.isFinite(coordinates.lng)) {
            params.set("ll", `${coordinates.lat},${coordinates.lng}`);
        } else {
            params.set("near", location || "nearby");
        }

        const response = await fetch(`https://places-api.foursquare.com/places/search?${params.toString()}`, {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${foursquareApiKey}`,
                "X-Places-Api-Version": "2025-06-17"
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Foursquare Places lookup failed:", response.status, errorText);
            return [];
        }

        const payload = await response.json();
        const places = Array.isArray(payload.results) ? payload.results : [];
        const enriched = [];

        for (const place of places) {
            const placeId = place.fsq_place_id || place.fsq_id;
            let tipsText = "";

            if (placeId) {
                try {
                    const tipsResponse = await fetch(`https://places-api.foursquare.com/places/${placeId}/tips?limit=2`, {
                        headers: {
                            Accept: "application/json",
                            Authorization: `Bearer ${foursquareApiKey}`,
                            "X-Places-Api-Version": "2025-06-17"
                        }
                    });

                    if (tipsResponse.ok) {
                        const tipsPayload = await tipsResponse.json();
                        const tipTexts = Array.isArray(tipsPayload.results)
                            ? tipsPayload.results
                                .map(item => item.text || item?.snippet?.text)
                                .filter(Boolean)
                                .slice(0, 2)
                            : [];

                        if (tipTexts.length) {
                            tipsText = tipTexts.join(" ");
                        }
                    }
                } catch (tipsError) {
                    console.error("Foursquare tips lookup failed:", tipsError);
                }
            }

            const placeName = place.name || "Destination";
            const address = place.location?.formatted_address || place.location?.address || location || "local area";
            const category = place.categories?.[0]?.name || "place";
            const rating = typeof place.rating === "number" ? place.rating : null;
            const ratingText = rating !== null
                ? `Rated ${rating.toFixed(1)} by travelers.`
                : "Popular local option.";
            const summary = [ratingText, tipsText, `This ${placeName} is well suited for ${queryText}.`].filter(Boolean).join(" ").trim();

            enriched.push({
                name: placeName,
                location: address,
                category,
                summary: summary || `This place is a strong fit for your trip around ${address}.`,
                why_it_matches: `This option matches your ${queryText} goals and fits the travel style you described.`
            });
        }

        return enriched;
    } catch (error) {
        console.error("Foursquare Places API error:", error);
        return [];
    }
}

async function researchPlacesForTrip(message, tripContext = {}, scheduleData = {}) {
    const userText = String(message || "").toLowerCase();
    const goals = tripContext.activityGoals || scheduleData.activityGoals || [];
    const location = tripContext.stayLocation || scheduleData.country || "";
    const userLocation = scheduleData.userLocation || scheduleData.currentLocation || tripContext.userLocation || null;
    const coordinates = userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)
        ? { lat: userLocation.lat, lng: userLocation.lng }
        : null;

    const searchableGoals = goals.length
        ? goals
        : [
            userText.includes("beach") ? "beach" : null,
            userText.includes("food") ? "food" : null,
            userText.includes("museum") ? "museum" : null,
            userText.includes("nature") ? "nature" : null,
            userText.includes("activity") ? "activity" : null,
            userText.includes("mall") || userText.includes("shopping") || userText.includes("store") ? "shopping" : null
        ].filter(Boolean);

    const queries = [];

    if (!searchableGoals.length) {
        if (userText.includes("beach")) queries.push("best beaches");
        if (userText.includes("food")) queries.push("best food spots");
        if (userText.includes("activity")) queries.push("popular activities");
        if (userText.includes("nature")) queries.push("nature trails");
        if (userText.includes("mall") || userText.includes("shopping") || userText.includes("store")) queries.push("nearby shopping mall");
    }

    searchableGoals.forEach(goal => {
        if (goal === "beach" || goal === "relaxing") queries.push("best beach and relaxed spots");
        if (goal === "food") queries.push("top restaurants and local food");
        if (goal === "activity") queries.push("popular activities and tours");
        if (goal === "nature") queries.push("nature parks and trails");
        if (goal === "culture") queries.push("culture and museum attractions");
        if (goal === "shopping") queries.push("shopping mall and retail spots");
    });

    const dedupedQueries = [...new Set(queries)].slice(0, 3);

    if (!dedupedQueries.length && !location && !coordinates) {
        return [];
    }

    const results = [];

    for (const query of dedupedQueries.length ? dedupedQueries : ["top attractions"]) {
        const matches = await searchFoursquarePlaces(query, location, coordinates);

        for (const place of matches) {
            results.push({
                name: place.name,
                location: place.location,
                category: place.category,
                summary: place.summary,
                why_it_matches: place.why_it_matches
            });
        }
    }

    return results.slice(0, 3);
}

function buildLocalRoamlyReply(message, scheduleData = {}) {
    const tripContext = inferTripContext(message);
    const activityGoals = tripContext.activityGoals?.length
        ? tripContext.activityGoals
        : (scheduleData.activityGoals || []);

    const stayText = tripContext.stayLocation || scheduleData.country || 'your destination';
    const hotelText = tripContext.hotel || scheduleData.hotel || 'your hotel';
    const lengthText = tripContext.stayLengthDays ?? scheduleData.stayLengthDays ?? 'your trip';
    const dayPrompt = tripContext.day ? `I’ve noted that ${tripContext.day} is a focus day for your ${activityGoals.join(', ')} plans.` : '';

    const actions = [];

    if (tripContext.hotel || scheduleData.hotel) {
        actions.push({
            type: 'SET_HOTEL',
            hotel: tripContext.hotel || scheduleData.hotel || hotelText,
            country: tripContext.stayLocation || scheduleData.country || stayText
        });
    }

    if (activityGoals.length) {
        const goalNameMap = {
            beach: 'Beach stop',
            relaxing: 'Relaxing day',
            food: 'Food stop',
            activity: 'Activity stop',
            nature: 'Nature stop',
            culture: 'Culture stop'
        };

        const chosenName = goalNameMap[activityGoals[0]] || 'Planned stop';
        const destinationLocation = tripContext.stayLocation || scheduleData.country || stayText;

        actions.push({
            type: 'ADD_DESTINATION',
            destination: {
                name: chosenName,
                location: destinationLocation,
                category: activityGoals[0] || 'place'
            }
        });

        const targetDay = tripContext.day || 'Monday';
        actions.push({
            type: 'ADD_TO_DAY',
            day: targetDay,
            name: chosenName
        });
    }

    const reply = [
        `I’ve got the plan context for ${stayText}. You’re staying at ${hotelText} and your trip lasts ${lengthText} days.`,
        `I’ve added the trip details and prepared ${activityGoals.length ? activityGoals.join(', ') : 'your'} recommendations for your schedule.`,
        dayPrompt,
        activityGoals.length
            ? `I can slot in ${activityGoals.join(', ')} ideas and keep the schedule organized for you.`
            : 'Tell me what kind of trip you want—relaxing, beach, food, or adventure—and I’ll build it into the calendar.'
    ].filter(Boolean).join(' ');

    return { reply, actions };
}

const ROAMLY_JR_INSTRUCTIONS = `
You are Roamly Jr., the AI travel assistant inside Roamly Schedule.

You control a user's travel plan through structured actions.

You can:
- Set the hotel
- Set the country
- Set the home base / hotel and location for this trip
- Store the trip's exact dates (start and end)
- Add destinations
- Remove destinations
- Add destinations to schedule days
- Remove destinations from schedule days
- Move destinations between days
- Clear a day
- Clear the entire schedule
- Read the user's complete current trip
- Help create a smart itinerary
- Suggest researched destinations with review summaries and travel notes

IMPORTANT:
- Treat the current trip as a persistent memory. If the user gives hotel, country, or trip dates, save them into this trip and refer to them later.
- Before adding any destination, make sure you know where the user is staying, how long they will stay, and what kind of trip they want.
- If the user's message reveals a hotel, stay location, stay length, trip dates, or travel mood, update the trip context immediately.
- If the user says they want a day to be relaxing, place relaxing/beach items on that day.
- If the user says 'Tuesday is my relaxing day', use actions that assign relaxing and beach-type items to Tuesday.
- If the user asks for beaches or nearby places, suggest destination options ranked by review quality, walk time, drive time, and distance from their stay.
- When you mention a destination or recommendation, give a short review-oriented summary like: 'Highly rated for beach access and easy walk from your hotel.'
- Never claim you changed the schedule unless the user requested a specific change or the trip context explicitly shows it.
- Never invent distances, ratings, or travel times unless clearly labeled as illustrative examples.
- If real trip data is not available, say that live searches still need to be connected.
- Be friendly, proactive, and concise.
- Keep Roamly Jr.'s personality polished, confident, upbeat, and genuinely helpful. He should feel premium and engaging, never childish, overly slangy, or gimmicky.
- Use light wit sparingly and only when it adds value; keep the tone mature, natural, and travel-savvy.
- Predict likely next questions and include 2-4 short follow-up suggestions that the user can click in the chat. These should feel like natural next steps, such as 'Search local food spots in Guyana', 'Add these places to my schedule', 'Find beaches nearby', or 'What should I do on my first day?'
- Ask a follow-up when needed: 'Before I add any place, can you tell me where you are staying and how long you will be staying?'
- Keep the reply conversational and mention helpful ideas like beaches, food, nature, or activities when the trip style is relaxing or active.
- Do not overuse exclamation marks, emoji, or exaggerated slang. Aim for modern, confident, non-childish energy.
- If the trip is specifically in a region or country, keep the home base and trip dates stored with that trip, not as a global default.
- Keep the user's live device location separate from the hotel/home base. Hotel and stay location are the trip anchor, while the current device location should only be used for nearby recommendations, travel comparisons, and local options.
- Never replace the hotel, home base, country, or trip dates with the user's current phone location.
- When a device location is available, use it to suggest nearby attractions, restaurants, or activities, but still keep the hotel and trip destination as the main context.

Return ONLY valid JSON in this format:

{
  "reply": "Your message to the user",
  "actions": [],
  "research": [],
  "suggestions": [
    { "label": "Search local food spots in this area", "value": "Search up local food spots in this area" }
  ]
}

Each research item should include:
{
  "name": "Place name",
  "location": "Area",
  "category": "beach",
  "summary": "Short review-based summary for the user",
  "why_it_matches": "Why it fits their trip"
}

Each action must use one of these types:

SET_HOTEL
{
  "type": "SET_HOTEL",
  "hotel": "Hotel name",
  "country": "Country"
}

ADD_DESTINATION
{
  "type": "ADD_DESTINATION",
  "destination": {
    "name": "Place name",
    "location": "Location",
    "category": "beach"
  }
}

REMOVE_DESTINATION
{
  "type": "REMOVE_DESTINATION",
  "name": "Place name"
}

ADD_TO_DAY
{
  "type": "ADD_TO_DAY",
  "day": "Monday",
  "name": "Place name"
}

REMOVE_FROM_DAY
{
  "type": "REMOVE_FROM_DAY",
  "day": "Monday",
  "name": "Place name"
}

MOVE_DESTINATION
{
  "type": "MOVE_DESTINATION",
  "fromDay": "Monday",
  "toDay": "Tuesday",
  "name": "Place name"
}

CLEAR_DAY
{
  "type": "CLEAR_DAY",
  "day": "Monday"
}

CLEAR_SCHEDULE
{
  "type": "CLEAR_SCHEDULE"
}

Use an empty actions array when the user is only asking a question.
`;


// ==========================================
// GEMINI REQUEST WITH RETRIES
// ==========================================

async function askGemini(prompt) {
    if (!ai) {
        return {
            text: JSON.stringify(buildLocalRoamlyReply(prompt, {}), null, 2)
        };
    }

    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            console.log(
                `Roamly Jr. → Gemini request (${attempt}/${MAX_ATTEMPTS})`
            );

            const response = await ai.models.generateContent({
                model: "gemini-3.6-flash",
                contents: prompt
            });

            return response;

        } catch (error) {
            console.error(
                `Gemini attempt ${attempt} failed:`,
                error.message || error
            );

            const status = error.status || error.code;

            const retryable =
                status === 429 ||
                status === 500 ||
                status === 502 ||
                status === 503 ||
                status === 504;

            if (!retryable || attempt === MAX_ATTEMPTS) {
                throw error;
            }

            const waitTime = attempt * 2000;

            console.log(
                `Retrying Gemini in ${waitTime / 1000} seconds...`
            );

            await new Promise(resolve =>
                setTimeout(resolve, waitTime)
            );
        }
    }
}


// ==========================================
// WEBSITE
// ==========================================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/auth/config", (req, res) => {
    res.json({
        success: true,
        googleClientId: process.env.GOOGLE_CLIENT_ID || null
    });
});

app.get("/api/trips", (req, res) => {
    const userId = String(req.query.userId || "").trim();

    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId" });
    }

    res.json({ success: true, trips: getUserTrips(userId) });
});

app.post("/api/trips", (req, res) => {
    const userId = String(req.body?.userId || "").trim();
    const trips = Array.isArray(req.body?.trips) ? req.body.trips : [];

    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId" });
    }

    setUserTrips(userId, trips);
    res.json({ success: true, trips: getUserTrips(userId) });
});


// ==========================================
// ROAMLY JR.
// ==========================================

app.post("/api/roamly-jr", async (req, res) => {
    try {
        const { message, scheduleData, userEmail } = req.body;
        const normalizedEmail = normalizeEmail(userEmail);

        if (!normalizedEmail) {
            return res.status(401).json({
                success: false,
                error: "To use Roamly Schedule, you need to log in first."
            });
        }

        const currentUsage = getUserDailyMessageCount(normalizedEmail);
        if (currentUsage >= DAILY_MESSAGE_LIMIT) {
            return res.status(429).json({
                success: false,
                error: `You have reached your daily message limit of ${DAILY_MESSAGE_LIMIT} messages. Please try again tomorrow.`
            });
        }

        if (!message || !message.trim()) {
            return res.status(400).json({
                success: false,
                error: "Please enter a message."
            });
        }

        const tripContext = inferTripContext(message);
        const followUp = buildFollowUpQuestion({
            hotel: scheduleData?.hotel || tripContext.hotel,
            stayLocation: scheduleData?.country || tripContext.stayLocation,
            stayLengthDays: scheduleData?.stayLengthDays || tripContext.stayLengthDays,
            activityGoals: tripContext.activityGoals
        });

        const prompt = `
${ROAMLY_JR_INSTRUCTIONS}

CURRENT COMPLETE TRIP DATA:
${JSON.stringify(scheduleData || {}, null, 2)}

TRIP CONTEXT FOUND IN THE MESSAGE:
${JSON.stringify(tripContext, null, 2)}

FOLLOW-UP NEEDED IF MISSING INFO:
${followUp}

USER REQUEST:
${message}
`;

        const liveResearch = await researchPlacesForTrip(message, tripContext, scheduleData || {});

        if (!ai) {
            const fallback = buildLocalRoamlyReply(message, scheduleData || {});
            incrementUserDailyMessageCount(normalizedEmail);
            return res.json({
                success: true,
                reply: fallback.reply,
                actions: fallback.actions,
                research: liveResearch,
                remainingMessages: Math.max(0, DAILY_MESSAGE_LIMIT - getUserDailyMessageCount(normalizedEmail)),
                dailyLimit: DAILY_MESSAGE_LIMIT
            });
        }

        const response = await askGemini(prompt);

        let rawText = (response?.text || "").trim();

        // Remove accidental markdown JSON fences
        rawText = rawText
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();

        let result;

        try {
            result = JSON.parse(rawText);
        } catch (parseError) {
            console.error("Gemini returned invalid JSON:", rawText);

            return res.status(500).json({
                success: false,
                error: "Roamly Jr. returned an invalid response. Please try again."
            });
        }

        if (!result.reply) {
            result.reply = "I'm ready to help with your trip.";
        }

        if (!Array.isArray(result.actions)) {
            result.actions = [];
        }

        const research = Array.isArray(result.research) && result.research.length
            ? result.research
            : liveResearch;

        incrementUserDailyMessageCount(normalizedEmail);

        res.json({
            success: true,
            reply: result.reply,
            actions: result.actions,
            research,
            remainingMessages: Math.max(0, DAILY_MESSAGE_LIMIT - getUserDailyMessageCount(normalizedEmail)),
            dailyLimit: DAILY_MESSAGE_LIMIT
        });

    } catch (error) {
        console.error("\n========== ROAMLY JR ERROR ==========");
        console.error(error);
        console.error("=====================================\n");

        const status = error.status || error.code;

        if (status === 503 || status === 502 || status === 504) {
            return res.status(503).json({
                success: false,
                error: "Gemini is temporarily busy. Please try again in a moment."
            });
        }

        if (status === 429) {
            return res.status(429).json({
                success: false,
                error: "Roamly Jr. is temporarily unavailable. Please try again in a moment."
            });
        }

        if (status === 401 || status === 403) {
            return res.status(500).json({
                success: false,
                error: "Roamly Jr. could not authenticate with Gemini."
            });
        }

        if (status === 404) {
            return res.status(500).json({
                success: false,
                error: "The configured Gemini model is unavailable."
            });
        }

        res.status(500).json({
            success: false,
            error: "Roamly Jr. encountered an unexpected error."
        });
    }
});


// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("======================================");
    console.log("       ROAMLY SCHEDULE");
    console.log("       Roamly Jr. AI READY");
    console.log("======================================");
    console.log(`Website: http://localhost:${PORT}`);
    console.log("======================================");
    console.log("");
});