import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  inferTripContext,
  assignActivityToDay,
  rankPlaces,
  buildFollowUpQuestion,
  buildSmartSchedulePlan,
  summarizeTripMemory,
  resolveTripDayKey,
  getMatchingDatesForDayName,
  buildGoogleMapsUrl,
  buildDepartureReminder,
  buildTripManagementPrompt,
  normalizeScheduleEntry,
  buildTimeAwareDaySummary,
  buildRoamlyJrWelcomeSequence,
  buildTripCreatedGuidance
} from './scheduler-logic.js';

test('inferTripContext captures stay, duration, and activity goals', () => {
  const result = inferTripContext(
    'I am staying at the Marriott in Oahu for 5 days and I want a relaxing trip with beaches.'
  );

  assert.equal(result.hotel, 'Marriott');
  assert.equal(result.stayLocation, 'Oahu');
  assert.equal(result.stayLengthDays, 5);
  assert.deepEqual(result.activityGoals, ['relaxing', 'beach']);
});

test('assignActivityToDay moves relaxing activities onto Tuesday', () => {
  const schedule = {
    Monday: [],
    Tuesday: [],
    Wednesday: [],
    Thursday: [],
    Friday: [],
    Saturday: [],
    Sunday: []
  };

  const result = assignActivityToDay(schedule, 'Tuesday', ['relaxing', 'beach']);

  assert.ok(result.Tuesday.includes('Relaxing day'));
  assert.ok(result.Tuesday.includes('Beach time'));
});

test('rankPlaces prefers closer walk times when rating is close', () => {
  const ranked = rankPlaces([
    { name: 'Marriott Hotel', rating: 4.9, walkMinutes: 25, driveMinutes: 18 },
    { name: 'Okinawa Hotel', rating: 4.4, walkMinutes: 2, driveMinutes: 7 },
    { name: 'Beachview Lodge', rating: 4.6, walkMinutes: 10, driveMinutes: 5 }
  ], 'relaxing');

  assert.equal(ranked[0].name, 'Okinawa Hotel');
  assert.equal(ranked[1].name, 'Beachview Lodge');
});

test('inferTripContext captures trip dates for a specific trip window', () => {
  const result = inferTripContext(
    'I will be staying at the Marriott Hotel in Guyana from January 10 2026 to January 17 2026.'
  );

  assert.equal(result.hotel, 'Marriott Hotel');
  assert.equal(result.stayLocation, 'Guyana');
  assert.equal(result.tripDates.startDate, '2026-01-10');
  assert.equal(result.tripDates.endDate, '2026-01-17');
  assert.equal(result.stayLengthDays, 8);
});

test('inferTripContext recognizes local shopping requests near the user', () => {
  const result = inferTripContext('Can you show me the nearest mall from my current location?');

  assert.ok(result.activityGoals.includes('shopping'));
});

test('buildFollowUpQuestion asks for stay and trip goals when missing context', () => {
  const question = buildFollowUpQuestion({});

  assert.match(question, /where.*staying|how long.*staying|what.*want.*do/i);
});

test('buildSmartSchedulePlan picks the best dates inside the trip window', () => {
  const plan = buildSmartSchedulePlan(
    {
      startDate: '2026-01-10',
      endDate: '2026-01-17',
      activityGoals: ['beach', 'relaxing']
    },
    [
      { name: 'Coconut Beach', category: 'beach', travelMinutes: 20 },
      { name: 'Rainforest Walk', category: 'nature', travelMinutes: 35 },
      { name: 'Downtown Food Market', category: 'food', travelMinutes: 15 }
    ]
  );

  assert.deepEqual(plan.map(item => item.name).sort(), ['Coconut Beach', 'Downtown Food Market', 'Rainforest Walk']);
  assert.ok(plan.every(item => item.date >= '2026-01-10' && item.date <= '2026-01-17'));
  assert.ok(plan.some(item => item.reason && item.reason.toLowerCase().includes('travel')));
});

test('summarizeTripMemory keeps a compact recall snapshot', () => {
  const summary = summarizeTripMemory([
    { text: 'Marriott in Guyana from Jan 10 to Jan 17', type: 'trip' },
    { text: 'Relaxing beach trip', type: 'goal' }
  ]);

  assert.match(summary, /Marriott/i);
  assert.match(summary, /beach/i);
  assert.match(summary, /Guyana/i);
});

test('resolveTripDayKey maps weekday names to the correct date inside the trip window', () => {
  const dateKey = resolveTripDayKey('Monday', {
    startDate: '2026-01-10',
    endDate: '2026-01-17'
  });

  assert.equal(dateKey, '2026-01-12');
});

test('getMatchingDatesForDayName finds multiple weekday matches across a longer trip', () => {
  const matches = getMatchingDatesForDayName('Monday', {
    startDate: '2026-01-10',
    endDate: '2026-01-25'
  });

  assert.deepEqual(matches, ['2026-01-12', '2026-01-19']);
});

test('buildGoogleMapsUrl encodes the destination query for direct navigation', () => {
  const url = buildGoogleMapsUrl('Coconut Beach', 'Trinidad and Tobago');

  assert.match(url, /^https:\/\/www\.google\.com\/maps\/search\/\?/i);
  assert.match(url, /Coconut\+Beach/i);
  assert.match(url, /Trinidad\+and\+Tobago/i);
});

test('buildDepartureReminder explains the reason for leaving soon', () => {
  const reminder = buildDepartureReminder({
    name: 'Coconut Beach',
    location: 'Trinidad and Tobago',
    minutesBefore: 30,
    travelMinutes: 20,
    weather: 'rainy',
    closingSoon: true
  });

  assert.match(reminder, /Get ready to leave in 30 minutes/i);
  assert.match(reminder, /traffic|weather|closing soon/i);
  assert.match(reminder, /Coconut Beach/i);
});

test('buildTripManagementPrompt explains the trip status in plain language', () => {
  const prompt = buildTripManagementPrompt({
    name: 'Curaçao Summer Trip',
    hotel: 'The Marriott',
    startDate: '2026-01-10',
    endDate: '2026-01-17',
    destinations: [{ name: 'Mambo Beach' }, { name: 'Christoffel' }]
  });

  assert.match(prompt, /Curaçao Summer Trip/i);
  assert.match(prompt, /The Marriott/i);
  assert.match(prompt, /2 destinations/i);
  assert.match(prompt, /reminders|maps|schedule/i);
});

test('normalizeScheduleEntry keeps time and reminder metadata together', () => {
  const entry = normalizeScheduleEntry({
    name: 'Mambo Beach',
    time: '15:30',
    reminderMinutes: 30
  });

  assert.equal(entry.name, 'Mambo Beach');
  assert.equal(entry.time, '15:30');
  assert.equal(entry.reminderMinutes, 30);
});

test('buildTimeAwareDaySummary lists the planned times for the day', () => {
  const summary = buildTimeAwareDaySummary([
    { name: 'Mambo Beach', time: '15:30', reminderMinutes: 30 },
    { name: 'Dinner', time: '19:00', reminderMinutes: 15 }
  ]);

  assert.match(summary, /15:30/i);
  assert.match(summary, /19:00/i);
  assert.match(summary, /2 time slots/i);
});

test('buildTripCreatedGuidance clearly tells the user the trip is open and ready inside the planner', () => {
  const guidance = buildTripCreatedGuidance('Curaçao Escape');

  assert.match(guidance, /Curaçao Escape/i);
  assert.match(guidance, /inside your trip/i);
  assert.match(guidance, /chat/i);
  assert.match(guidance, /ready/i);
});

test('buildRoamlyJrWelcomeSequence includes the required login prompt and feature overview', () => {
  const sequence = buildRoamlyJrWelcomeSequence();

  assert.ok(Array.isArray(sequence));
  assert.ok(sequence.some(message => /Roamly\.Jr\./i.test(message)));
  assert.ok(sequence.some(message => /trip|schedule|destinations|activities|smart plan/i.test(message)));
  assert.ok(sequence.some(message => /To use Roamly Schedule, you need to log in first\./i.test(message)));
});

test('PWA setup uses local manifest icons and registers the service worker', () => {
  const manifest = JSON.parse(fs.readFileSync('./manifest.json', 'utf8'));
  const appSource = fs.readFileSync('./app.js', 'utf8');
  const html = fs.readFileSync('./index.html', 'utf8');

  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  assert.match(manifest.icons[0].src, /icon-192\.svg/i);
  assert.match(manifest.icons[1].src, /icon-512\.svg/i);
  assert.match(appSource, /navigator\.serviceWorker\.register/i);
  assert.match(html, /rel="manifest"/i);
});
