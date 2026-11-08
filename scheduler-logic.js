export const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
];

const ACTIVITY_MAP = {
  relaxing: ['relaxing', 'relax', 'rest', 'chill', 'slow', 'beach', 'pool', 'spa', 'lounging'],
  food: ['food', 'eat', 'restaurant', 'dining', 'brunch', 'coffee', 'drinks'],
  activity: ['activity', 'adventure', 'explore', 'tour', 'hike', 'adventurous', 'sightseeing'],
  beach: ['beach', 'shore', 'coast', 'ocean', 'sunbathe', 'snorkel'],
  nature: ['nature', 'hike', 'trail', 'park', 'garden', 'waterfall'],
  culture: ['museum', 'culture', 'historic', 'art', 'landmark'],
  shopping: ['shopping', 'shop', 'mall', 'store', 'stores', 'boutique', 'retail']
};

const DAY_ALIASES = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday'
};

function normalizeText(value = '') {
  return String(value).trim().toLowerCase();
}

function titleCaseValue(value = '') {
  return String(value)
    .replace(/^\s+|\s+$/g, '')
    .replace(/\bthe\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11
};

function parseDateString(dateText = '') {
  const text = String(dateText || '').trim();
  if (!text) return null;

  const match = text.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,)?\s*(\d{4})?/i);

  if (!match) return null;

  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3] || new Date().getFullYear());

  if (Number.isNaN(month) || Number.isNaN(day) || Number.isNaN(year)) {
    return null;
  }

  const isoDate = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(isoDate.getTime())) return null;

  return {
    year,
    month,
    day,
    iso: isoDate.toISOString().slice(0, 10)
  };
}

function extractTripDateRange(rawMessage = '') {
  const text = String(rawMessage || '').trim();
  const patterns = [
    /(?:from|starting\s+on|beginning\s+on)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,)?\s*(\d{4})?\s+(?:to|through|until|and)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,)?\s*(\d{4})?/i,
    /(?:between)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,)?\s*(\d{4})?\s+(?:and|to)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,)?\s*(\d{4})?/i,
    /(?:from|starting\s+on|beginning\s+on)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,)?\s*(\d{4})?\s*[-–]\s*(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:,)?\s*(\d{4})?/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const start = parseDateString(`${match[1]} ${match[2]} ${match[3] || new Date().getFullYear()}`);
    const end = parseDateString(`${match[4] || match[1]} ${match[5] || match[2]} ${match[6] || match[3] || new Date().getFullYear()}`);

    if (start && end) {
      return {
        startDate: start.iso,
        endDate: end.iso
      };
    }
  }

  return null;
}

function findMatchingTag(text, tags) {
  return tags.find(tag => text.includes(tag));
}

function getActivityGoals(text) {
  const goals = [];

  if (text.includes('relax') || text.includes('chill') || text.includes('beach')) {
    goals.push('relaxing');
  }

  if (text.includes('beach') || text.includes('ocean') || text.includes('shore')) {
    goals.push('beach');
  }

  if (text.includes('food') || text.includes('restaurant') || text.includes('dining')) {
    goals.push('food');
  }

  if (text.includes('hike') || text.includes('activity') || text.includes('adventure')) {
    goals.push('activity');
  }

  if (text.includes('museum') || text.includes('culture') || text.includes('historic')) {
    goals.push('culture');
  }

  if (text.includes('nature') || text.includes('park') || text.includes('trail')) {
    goals.push('nature');
  }

  if (text.includes('mall') || text.includes('shopping') || text.includes('store') || text.includes('retail') || text.includes('boutique')) {
    goals.push('shopping');
  }

  return Array.from(new Set(goals));
}

export function inferTripContext(message = '') {
  const rawMessage = String(message || '').trim();
  const text = normalizeText(rawMessage);

  const hotelPattern = /(?:staying at|stay at|stay in|hotel|lodging|booking|booked|room at)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 .'-]{0,30}?)(?=\s+(?:in|near|around|at)\s+[A-Za-z]|\s+(?:for|and|with|but|on|from|to)\b|$)/i;
  const stayLocationPattern = /(?:staying at|stay at|stay in|hotel|lodging|booking|booked|room at)[A-Za-z0-9 .'-]*?(?:in|near|around|at)\s+(?:the\s+)?([A-Za-z][A-Za-z .'-]{1,40}?)(?=\s+(?:for|and|with|but|on|from|to)\b|$)/i;
  const hotelMatch = rawMessage.match(hotelPattern);
  const stayLocationMatch = rawMessage.match(stayLocationPattern);
  const stayLengthMatch = rawMessage.match(/for\s+(\d+)\s+(?:days?|nights?)|staying\s+(\d+)\s+(?:days?|nights?)|trip\s+is\s+(\d+)\s+(?:days?|nights?)/i);
  const dayMatch = Object.entries(DAY_ALIASES).find(([key]) => text.includes(key));
  const tripDates = extractTripDateRange(rawMessage);

  let hotel = hotelMatch ? hotelMatch[1].replace(/\s+/g, ' ').trim() : '';
  let stayLocation = stayLocationMatch ? stayLocationMatch[1].replace(/\s+/g, ' ').trim() : '';

  if (stayLocation) {
    const locationMatch = stayLocation.match(/(?:in|near|around|at)\s+(.*)$/i);
    stayLocation = titleCaseValue(locationMatch ? locationMatch[1] : stayLocation);
  }

  if (hotel) {
    hotel = titleCaseValue(hotel);
    if (stayLocation) {
      hotel = hotel.replace(new RegExp(`\\s*${stayLocation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '').trim();
    }
    hotel = titleCaseValue(hotel);
  }

  const stayLengthDays = stayLengthMatch
    ? Number(stayLengthMatch[1] || stayLengthMatch[2] || stayLengthMatch[3])
    : (tripDates && tripDates.startDate && tripDates.endDate
      ? Math.round((new Date(tripDates.endDate) - new Date(tripDates.startDate)) / 86400000) + 1
      : undefined);

  const activityGoals = getActivityGoals(text);

  return {
    hotel: hotel || '',
    stayLocation: stayLocation || '',
    stayLengthDays: Number.isFinite(stayLengthDays) ? stayLengthDays : undefined,
    activityGoals,
    day: dayMatch ? DAY_ALIASES[dayMatch[0]] : undefined,
    tripDates: tripDates || undefined
  };
}

export function assignActivityToDay(schedule = {}, day, activityGoals = []) {
  const normalizedSchedule = { ...schedule };
  const safeDay = DAY_ALIASES[normalizeText(day)] || day;
  const nextActivities = Array.isArray(activityGoals) ? activityGoals : [];
  const assigned = new Set(normalizedSchedule[safeDay] || []);

  const actionMap = {
    relaxing: ['Relaxing day', 'Beach time'],
    beach: ['Beach time', 'Sunset walk'],
    food: ['Food stop', 'Dinner plan'],
    activity: ['Adventure time', 'Outdoor activity'],
    nature: ['Nature outing', 'Trail walk'],
    culture: ['Culture stop', 'Museum visit']
  };

  nextActivities.forEach(goal => {
    const list = actionMap[goal] || [];
    list.forEach(item => assigned.add(item));
  });

  normalizedSchedule[safeDay] = Array.from(assigned);
  return normalizedSchedule;
}

export function rankPlaces(places = [], activityContext = '') {
  const text = normalizeText(activityContext);
  const scored = places.map(place => {
    const ratingScore = Number(place.rating) || 0;
    const walkMinutes = Number(place.walkMinutes) || 999;
    const driveMinutes = Number(place.driveMinutes) || 999;
    const reviewScore = Number(place.reviews) || 0;

    let score = ratingScore * 25;
    score += Math.max(0, 100 - walkMinutes * 2);
    score += Math.max(0, 100 - driveMinutes * 1.5);
    score += Math.min(reviewScore, 100) * 0.1;

    if (text.includes('relax') || text.includes('beach')) {
      score += (Number(place.rating) || 0) * 10;
      score -= walkMinutes * 0.6;
      score -= driveMinutes * 0.25;
    }

    if (text.includes('food')) {
      score += (Number(place.foodScore) || 0) * 8;
    }

    return {
      ...place,
      score
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}

export function buildFollowUpQuestion(context = {}) {
  const missing = [];

  if (!context.hotel && !context.stayLocation) {
    missing.push('where you are staying');
  }

  if (!context.stayLengthDays) {
    missing.push('how long you will be staying');
  }

  if (!Array.isArray(context.activityGoals) || !context.activityGoals.length) {
    missing.push('what you want to do on the trip');
  }

  if (!missing.length) {
    return 'Do you want me to look up beaches near your hotel or home base?';
  }

  if (missing.length === 1) {
    return `Before I add any place, can you tell me ${missing[0]}?`;
  }

  return `Before I add any place, can you tell me ${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}?`;
}

export function summarizeTripMemory(memoryEntries = []) {
  const entries = Array.isArray(memoryEntries) ? memoryEntries : [];
  const text = entries
    .map(entry => String(entry?.text || entry || '').trim())
    .filter(Boolean)
    .join(' • ');

  if (!text) {
    return 'No trip memory saved yet.';
  }

  return text;
}

export function buildGoogleMapsUrl(name = '', location = '') {
  const query = [name, location].filter(Boolean).join(' ');
  const encoded = encodeURIComponent(query || 'travel destination').replace(/%20/g, '+');
  return `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

export function buildDepartureReminder(options = {}) {
  const {
    name = 'your destination',
    location = '',
    minutesBefore = 30,
    travelMinutes = 20,
    weather = 'good',
    closingSoon = false
  } = options || {};

  const reasonParts = [];

  if (travelMinutes && Number(travelMinutes) > 0) {
    reasonParts.push(`it takes about ${Number(travelMinutes)} minutes to reach ${name}`);
  }

  if (weather && weather !== 'good') {
    reasonParts.push(`the weather looks ${weather}`);
  } else if (weather && weather !== 'clear') {
    reasonParts.push(`weather is looking ${weather}`);
  }

  if (closingSoon) {
    reasonParts.push(`${name} may close soon`);
  }

  if (!reasonParts.length) {
    reasonParts.push('traffic is looking manageable');
  }

  const reason = reasonParts.join(', ');
  const locationText = location ? ` in ${location}` : '';

  return `Get ready to leave in ${minutesBefore} minutes for ${name}${locationText}. Roamly checked the route and ${reason}.`;
}

export function buildTripManagementPrompt(trip = {}) {
  const name = trip.name || 'your trip';
  const hotel = trip.hotel || 'your home base';
  const start = trip.startDate || 'your start date';
  const end = trip.endDate || 'your end date';
  const destinations = Array.isArray(trip.destinations) ? trip.destinations : [];
  const destinationCount = destinations.length;

  const destinationLine = destinationCount
    ? `${destinationCount} destination${destinationCount === 1 ? '' : 's'} planned`
    : 'destination list still being built';

  const scheduleLine = Array.isArray(trip.schedule)
    ? 'schedule is ready to refine'
    : 'schedule is organized and ready';

  return `${name} is set with ${hotel} as your base from ${start} to ${end}. ${destinationLine}. Roamly can open maps for each stop, send reminders before departures, and keep your ${scheduleLine} with trip management prompts.`;
}

function normalizeClockTime(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) {
    const isoMatch = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!isoMatch) return '';
    const hour = Number(isoMatch[1]);
    const minute = Number(isoMatch[2]);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return '';
    if (hour > 23 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || '0');
  const suffix = (match[3] || '').toLowerCase();

  if (Number.isNaN(hour) || Number.isNaN(minute)) return '';
  if (hour > 23 || minute > 59) return '';

  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeScheduleEntry(entry = '') {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const name = String(entry.name || entry.title || '').trim();
    const time = normalizeClockTime(entry.time || entry.startTime || '');
    const reminderMinutes = Number(entry.reminderMinutes ?? entry.reminder ?? 0);

    return {
      name,
      time,
      reminderMinutes: Number.isFinite(reminderMinutes) ? Math.max(0, reminderMinutes) : 0,
      location: String(entry.location || ''),
      reason: String(entry.reason || ''),
      category: String(entry.category || '')
    };
  }

  const stringValue = String(entry || '').trim();
  return {
    name: stringValue,
    time: '',
    reminderMinutes: 0,
    location: '',
    reason: '',
    category: ''
  };
}

export function buildTimeAwareDaySummary(entries = []) {
  const normalized = Array.isArray(entries)
    ? entries.map(normalizeScheduleEntry).filter(item => item.name)
    : [];

  if (!normalized.length) {
    return 'No time slots planned yet.';
  }

  const details = normalized
    .map(item => item.time ? `${item.time}${item.reminderMinutes ? ` (reminder ${item.reminderMinutes}m)` : ''}` : 'Flexible time slot')
    .join(', ');

  return `${normalized.length} time slot${normalized.length === 1 ? '' : 's'} planned: ${details}.`;
}

export function buildSmartSchedulePlan(tripContext = {}, destinations = []) {
  const startDate = tripContext.startDate || tripContext.tripDates?.startDate;
  const endDate = tripContext.endDate || tripContext.tripDates?.endDate;
  const goals = Array.isArray(tripContext.activityGoals) ? tripContext.activityGoals : [];

  if (!startDate || !endDate || !Array.isArray(destinations) || !destinations.length) {
    return [];
  }

  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  const totalDays = Math.max(1, Math.round((end - start) / 86400000) + 1);

  const scored = destinations
    .map((destination, index) => {
      const category = String(destination.category || 'place').toLowerCase();
      const travelMinutes = Number(destination.travelMinutes ?? destination.driveMinutes ?? destination.walkMinutes ?? 30);
      let score = 20;

      if (category.includes('beach')) score += 30;
      if (category.includes('food')) score += 18;
      if (category.includes('nature') || category.includes('park')) score += 22;
      if (category.includes('culture') || category.includes('museum')) score += 16;
      if (category.includes('activity') || category.includes('tour')) score += 24;
      if (goals.some(goal => goal.toLowerCase().includes(category))) score += 20;
      score -= Math.min(travelMinutes, 120) * 0.2;
      score += index * 0.5;

      return {
        ...destination,
        travelMinutes,
        score,
        weatherFit: /(beach|nature|activity|tour)/.test(category)
          ? 'weather-friendly outdoor plan'
          : 'good for flexible daytime exploring'
      };
    })
    .sort((a, b) => b.score - a.score || a.travelMinutes - b.travelMinutes);

  const plan = [];

  scored.forEach((destination, index) => {
    const offset = index % totalDays;
    const date = new Date(start);
    date.setDate(start.getDate() + offset);

    const isoDate = date.toISOString().slice(0, 10);

    plan.push({
      name: destination.name,
      date: isoDate,
      category: destination.category || 'place',
      location: destination.location || '',
      travelMinutes: destination.travelMinutes,
      reason: `${destination.name} is a strong fit for ${goals.join(', ') || 'your trip'} because it keeps travel to about ${destination.travelMinutes} minutes and matches a ${destination.weatherFit}.`
    });
  });

  return plan.slice(0, Math.min(plan.length, totalDays));
}

export function getMatchingDatesForDayName(dayName, tripContext = {}) {
  const rawDay = String(dayName || '').trim();
  const normalizedDay = DAY_ALIASES[normalizeText(rawDay)] || rawDay;
  const startDate = tripContext.startDate || tripContext.tripDates?.startDate;
  const endDate = tripContext.endDate || tripContext.tripDates?.endDate;

  if (!normalizedDay || !startDate || !endDate) {
    return [];
  }

  const dayIndex = DAYS.indexOf(normalizedDay);
  if (dayIndex === -1) {
    return [];
  }

  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  const matches = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    if (cursor.getDay() === ((dayIndex + 1) % 7)) {
      matches.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return matches;
}

export function resolveTripDayKey(dayName, tripContext = {}) {
  const rawDay = String(dayName || '').trim();
  const normalizedDay = DAY_ALIASES[normalizeText(rawDay)] || rawDay;
  const startDate = tripContext.startDate || tripContext.tripDates?.startDate;
  const endDate = tripContext.endDate || tripContext.tripDates?.endDate;

  if (!normalizedDay || !startDate || !endDate) {
    return normalizedDay || rawDay;
  }

  const matches = getMatchingDatesForDayName(normalizedDay, tripContext);
  if (matches.length) {
    return matches[0];
  }

  const dayIndex = DAYS.indexOf(normalizedDay);
  if (dayIndex === -1) {
    return normalizedDay;
  }

  const start = new Date(`${startDate}T12:00:00`);
  const currentIndex = (start.getDay() + 6) % 7;
  const offset = (dayIndex - currentIndex + 7) % 7;
  const targetDate = new Date(start);
  targetDate.setDate(start.getDate() + offset);

  if (targetDate < new Date(`${startDate}T12:00:00`)) {
    targetDate.setDate(targetDate.getDate() + 7);
  }

  if (targetDate > new Date(`${endDate}T12:00:00`)) {
    return normalizedDay;
  }

  return targetDate.toISOString().slice(0, 10);
}

export function buildTripCreatedGuidance(tripName = 'your trip') {
  const safeName = String(tripName || 'your trip').trim() || 'your trip';
  return `Nice work — ${safeName} is ready. You’re now inside your trip, and the planner is open. Next, click Chat to tell Roamly what to plan for this trip.`;
}

export function buildRoamlyJrWelcomeSequence() {
  return [
    'Hi, I\'m Roamly.Jr. 👋 I\'ll walk you through the basics and show you how this planner works.',
    'You can build a trip, save destinations, and organize each stop into an itinerary that matches your travel style.',
    'I can help you find beaches, food spots, activities, and smart trip ideas based on where you are staying and what you want to do.',
    'When you are ready, I can also help plan the full schedule for your trip and keep your reminders in sync.',
    'To use Roamly Schedule, you need to log in first.'
  ];
}

export function parseMemoryRecall(text = '') {
  const message = String(text || '').toLowerCase();
  const keywords = ['remember', 'recall', 'my trip', 'trip details', 'what do you remember'];
  return keywords.some(keyword => message.includes(keyword));
}
