/**
 * Demo property config, public facts from erth.ae (+ property fact sheet / major OTAs).
 * Labelled DEMO / SAMPLE. Not an official Erth product or endorsement.
 * Sources: https://erth.ae/ · dining · accommodations · fitness · services · story
 */

export const RESORT = {
  name: 'Erth Abu Dhabi',
  tagline: 'Demo · public facts from erth.ae',
  propertyLabel: 'Erth Abu Dhabi, Reservations (Demo)',
  brandNote: 'Proudly Emirati hospitality · “Marhaba Al Sa’a”',
  city: 'Abu Dhabi',
  address: 'Khor Al Maqta, Al Khaleej Al Arabi Road, Abu Dhabi',
  poBox: 'P.O. Box 29810, Abu Dhabi, UAE',
  phone: '800 ERTH (3784) · +971 2 441 5900',
  reservationsPhone: '+971 2 497 5308',
  diningPhone: '+971 2 497 5831 · +971 56 533 4246',
  whatsappDesk: '+971 50 XXX XXXX (demo desk notify)',
  emailDesk: 'reservation@erth.ae',
  emailGeneral: 'igrab@erth.ae',
  emailDining: 'Dining@erth.ae',
  website: 'https://erth.ae/',
  checkInTime: '15:00',
  checkOutTime: '12:00',
  checkInWindow: '15:00–00:00',
  frontDeskOpens: '08:00',
  frontDeskCloses: '22:00',
  location:
    'Khor Al Maqta, Al Khaleej Al Arabi Road, Abu Dhabi (P.O. Box 29810). About 15 minutes from downtown and about 15 minutes’ drive from Zayed International Airport (property fact sheet), near Sheikh Zayed Grand Mosque and Wahat Al Karama, with easy highway access.',
  nearby: [
    'Sheikh Zayed Grand Mosque (~4 km)',
    'Wahat Al Karama memorial',
    'Downtown Abu Dhabi (~15 minutes)',
    'Zayed International Airport (~15 minutes’ drive)',
    'Ferrari World Abu Dhabi (~24 km)',
  ],
  beach:
    '350m private Blue Flag–certified beach at Al Waryah, two oasis-shaped swimming pools, loungers, family-friendly. Water sports: kayaking, stand-up paddle boarding, jet skis and more (book via desk).',
  parking:
    'Free private on-site parking (no reservation needed). Free valet commonly listed. EV charging and accessible parking available.',
  wifi: 'Complimentary high-speed Wi‑Fi in rooms and public areas. Wired internet listed for business needs.',
  pets: 'Pets are not permitted. For service animals, please confirm with reservations in advance.',
  deposit:
    'A refundable damage deposit may apply at check-in (public listings cite about AED 2,000; please confirm with reservations). Photo ID and credit card typically required; please advise arrival time in advance.',
  roomService: '24-hour room service is available for in-house guests.',
  halal: 'Halal meals are provided across dining outlets.',
  starRating: '5-star resort positioning on major booking platforms.',
  inventoryNote:
    'Public fact sheet notes extensive inventory: deluxe rooms, dozens of suites, beach villas, and 1-/2-/3-bedroom pool villas, live availability confirmed by reservations only.',
  languages: ['English', 'Arabic'] as const,
  demoBadge: 'DEMO / SAMPLE · facts from erth.ae',
  seller: {
    name: 'Usama Malik',
    role: 'Independent AI Engineer',
    market: 'Gulf hospitality',
  },
  story:
    'Erth means legacy. In 1983 Sheikh Zayed envisioned a recreational space for UAE Armed Forces officers on ~75 hectares. The Officers Club opened 1 Dec 1997; opened to the public in 2003 as the Armed Forces Officers Club and Hotel; reinvented as Erth in 2021, resort, ballroom, and recreation. Values: Always Honourable, Proudly Emirati, Genuinely Personal, “Marhaba Al Sa’a”.',
  awards: [
    'Michelin Guide: One Michelin Key 2025',
    'Leaders in Hospitality: Sustainable Hotel of the Year 2025',
    'Leaders in Hospitality: Hotel Gym of the Year 2025',
    'Leaders in Hospitality: CSR Initiative of the Year 2025',
    'World Travel Awards: UAE Leading Family Hotel 2024',
    'World Travel Awards: Abu Dhabi Leading Hotel Villas 2024',
    'World Culinary Awards: Best Catering & Hospitality Company (Erth Hospitality) 2024',
    'Leaders in F&B: Best F&B Sustainable Practices 2024',
    'Erth Restaurant (Al Hosn): Michelin star, three consecutive years',
  ],
} as const

export const PRICING = {
  SETUP_FEE: 'AED ____',
  MONTHLY_FEE: 'AED ____',
  disclaimer: 'Proposal draft. Confirm with Usama before quoting',
  currencyNote: 'Placeholders only. Not a formal quote.',
} as const

export const DINING = {
  alRimal: {
    name: 'Al Rimal',
    meaning: 'the sands',
    en: 'Emirati-inspired buffet with live show kitchens, Arabic bread, mezze, traditional desserts, plus international options. Outdoor seating overlooks the central garden; lounge and coffee bar.',
    ar: 'بوفيه إماراتي مع مطابخ حية، خبز عربي، مقبلات، حلويات، وخيارات عالمية. جلسات تطل على الحديقة.',
    hours: 'Breakfast 05:30–10:30 · Lunch 12:00–16:00 · Dinner 18:00–23:00',
  },
  ergon: {
    name: 'Ergon Deli & Café',
    en: 'Modern Greek / Mediterranean, brunches to intimate dinners.',
    ar: 'مطبخ يوناني متوسطي، من البرانش إلى العشاء.',
    hours: 'Daily 08:00–23:00',
  },
  asrah: {
    name: 'Asrah',
    en: 'Poolside at Al Waryah, beverages, light snacks, desserts.',
    ar: 'بجانب مسبح الوَرية: مشروبات ووجبات خفيفة وحلويات.',
    hours: 'Daily 08:00–20:00',
  },
  beetza: {
    name: 'Beetza',
    en: 'Neapolitan pizzeria with Italian-sourced ingredients.',
    ar: 'بيتزا نابولية بمكونات إيطالية.',
    hours: 'Mon–Thu 12:00–23:00 · Fri–Sun 12:00–00:00',
  },
  erthAlHosn: {
    name: 'Erth Restaurant (Al Hosn)',
    en: 'Michelin-starred Emirati fine dining near Qasr Al Hosn (city centre, separate from resort campus).',
    ar: 'مطعم إرث الحصن بنجمة ميشلان، موقعه وسط المدينة منفصل عن المنتجع.',
    hours: 'Confirm with restaurant: +971 58 600 6922 · info@erthrestaurant.ae',
  },
  culture:
    'Authentic Emirati cuisine, Ghawah (Arabic coffee), dates, and Khaleeji patisserie, food is central to Emirati hospitality here. Halal meals provided.',
} as const

export const ROOMS = {
  summary:
    'Rooms, suites, and beach/pool villas with Emirati design and garden or sea views. Suites and villas include Al Rayeh Club Lounge access (confirm current status) and dedicated Mudeef (host) service. Interconnecting rooms on request for select categories.',
  /** Guest-facing numbered choices: from erth.ae/accommodations */
  choices: [
    {
      id: 1,
      name: 'Al Ubayya Deluxe Room',
      size: '36 m²',
      short: 'King · facilities view · 2 adults or 2+1 child',
    },
    {
      id: 2,
      name: 'Al Hadiqa Deluxe Room',
      size: '36 m²',
      short: 'King or twin · Al Fayy garden · 2 adults or 2+1 child',
    },
    {
      id: 3,
      name: 'Minhaf Executive Suite',
      size: '64 m²',
      short: 'King + living · Al Rayeh + Mudeef · up to 3 adults or 2+2 children',
    },
    {
      id: 4,
      name: 'Al Muradi Family Suite',
      size: '64 m²',
      short: 'King + kids bunks + living · ideal for families',
    },
    {
      id: 5,
      name: 'Erth Suite',
      size: '140 m²',
      short: 'King + living + balcony · garden views · Al Rayeh + Mudeef',
    },
    {
      id: 6,
      name: 'Rabdan Suite',
      size: '175 m²',
      short: 'Large suite · living + balcony · up to 4 adults',
    },
    {
      id: 7,
      name: 'One-Bedroom Beach Villa',
      size: '74 m²',
      short: 'Beachfront · outdoor shower · Al Rayeh + Mudeef',
    },
    {
      id: 8,
      name: 'One-Bedroom Pool Villa',
      size: '74 m²',
      short: 'Private plunge pool · beach cabana · sea view',
    },
    {
      id: 9,
      name: 'Two-Bedroom Pool Villa',
      size: '127 m²',
      short: 'King + twins · private pool · beach cabana',
    },
    {
      id: 10,
      name: 'Erth Three-Bedroom Pool Villa',
      size: '245 m²',
      short: 'Three kings · pool + jacuzzi · courtyard · beach cabana',
    },
  ],
  categories: [
    { name: 'Al Ubayya Deluxe Room', size: '36 m²', occupancy: '2 adults or 2+1 child <12', bed: 'King', notes: 'Facilities view; sustainable palm accents' },
    { name: 'Al Hadiqa Deluxe Room', size: '36 m²', occupancy: '2 adults or 2+1 child <12', bed: 'King or twin', notes: 'Al Fayy garden access' },
    { name: 'Minhaf Executive Suite', size: '64 m²', occupancy: '3 adults or 2+2 children <12', bed: 'King + living', notes: 'Al Rayeh + Mudeef' },
    { name: 'Al Muradi Family Suite', size: '64 m²', occupancy: '4 adults or 2+2 children <12', bed: 'King + bunks + living', notes: 'Family; Al Rayeh + Mudeef' },
    { name: 'Erth Suite', size: '140 m²', occupancy: '2 adults or 2+2 children <12', bed: 'King + living + balcony', notes: 'Garden; pantry; extra bed on request' },
    { name: 'Rabdan Suite', size: '175 m²', occupancy: '4 adults or 4+2 children <12', bed: 'King + living + balcony', notes: 'Al Rayeh + Mudeef' },
    { name: 'Al Hidra Suite', size: '84 m²', occupancy: '4 adults or 4+2 children <12', bed: 'King + living', notes: 'Al Rayeh + Mudeef; interconnecting on request' },
    { name: 'One-Bedroom Beach Villa', size: '74 m²', occupancy: '2 adults or 2+2 children <12', bed: 'King', notes: 'Beachfront; outdoor shower' },
    { name: 'One-Bedroom Pool Villa', size: '74 m²', occupancy: '2 adults or 2+2 children <12', bed: 'King', notes: 'Private plunge pool; beach cabana' },
    { name: 'Two-Bedroom Pool Villa', size: '127 m²', occupancy: 'confirm with reservations', bed: 'King + twins', notes: 'Private pool; dining deck' },
    { name: 'Erth Three-Bedroom Pool Villa', size: '245 m²', occupancy: 'confirm with reservations', bed: 'Three kings', notes: 'Pool + jacuzzi; courtyard; cabana' },
  ],
  amenities: [
    'Mini bar',
    'Tea & espresso maker',
    'Iron & board',
    'Prayer mat on request',
    '50" / 65" TV + cable/satellite',
    'Bluetooth speaker',
    'USB chargers',
    'Complimentary high-speed Wi‑Fi',
    '24/7 laundry',
    '24-hour room service',
    'Daily international newspaper',
    'In-house florist',
    'In-room safe',
    'Interconnecting rooms (select, on request)',
  ],
} as const

export const SERVICES = {
  butler: 'Butler service, packing/unpacking and personalised assistance for an effortless stay.',
  shoeShine: 'Complimentary shoe shine.',
  ironing: 'Professional ironing / pressing for any occasion.',
  kidsClub: 'Kids Club, activities and play so children can discover, have fun, and make memories (confirm ages & hours at desk).',
  carWash: 'Premium car wash on site, call 050 270 5973 or 050 270 6089.',
  concierge: 'Concierge for tours, tickets, dining bookings, and local tips during desk hours.',
  luggage: 'Luggage storage for early arrivals or late departures.',
  business: 'Business centre / meeting support; 17 event venues on property.',
  currency: 'Currency exchange, ask front desk for current availability.',
  housekeeping: 'Daily housekeeping; 24/7 laundry and dry cleaning.',
  express: 'Express check-in / check-out may be available, ask arrivals.',
  florist: 'In-house florist.',
  airportShuttle:
    'Airport pick-up / drop-off and shuttle listed (usually surcharge). Share flight number and ETA and I’ll notify the desk to arrange.',
  playground: 'Children’s playground listed among family facilities.',
} as const

export const WELLNESS = {
  spa: {
    name: 'Valmont Spa at Erth Abu Dhabi',
    en: 'First Valmont Spa in Abu Dhabi, Swiss skincare in a pool villa overlooking Khor Al Maqta. Signature treatments: Vitality of the Glaciers, Hydration of the Bisses, Lift from the Peaks.',
    ar: 'أول سبا فالمونت في أبوظبي: عناية سويسرية في فيلا بمسبح تطل على خور المقطع.',
    hours: 'Daily 11:00–20:00',
  },
  fitness: {
    name: 'Etizan Fitness',
    en: 'Major recreation campus (~58–65k sqm): mixed gym ~2,260 m², ladies gym ~1,180 m² + studios, padel (3 indoor + 2 outdoor; ladies court), tennis, Olympic indoor pool 50m/8 lanes + kids/beginners pools, FIFA pitch 105×68m, football courts, squash, boxing, spin/functional studios, neon bowling (4 lanes), Running & Cycling Club. Hotel Gym of the Year 2025.',
    ar: 'إتيزان: صالة مختلطة حوالي ٢٢٦٠ م²، سيدات حوالي ١١٨٠ م²، بادل، تنس، مسبح أولمبي، ملعب فيفا، بولينغ والمزيد.',
  },
  pools: {
    en: 'Two oasis-shaped outdoor pools plus Blue Flag beach 350m. Indoor Olympic pool about 50m / 2.5m, 8 lanes, kids and beginners pools. Ladies-only access windows: please confirm timings.',
    ar: 'مسبحان خارجيان وشاطئ العلم الأزرق، ومسبح داخلي أولمبي مع مسابح أطفال. فترات السيدات تُؤكَّد مع المنتجع.',
  },
  waterSports: {
    en: 'Kayaking, stand-up paddle boarding, jet skis and more, book via desk / recreation.',
    ar: 'كاياك، وتجديف وقوفاً، وجت سكي. الحجز عبر الاستقبال.',
  },
} as const

export const EVENTS = {
  en: '17 venues including ballroom, cinema, and theatre, weddings, seminars, conferences, launches, exhibitions. Dedicated events team; Erth Hospitality catering.',
  ar: '١٧ مساحة فعاليات: أعراس ومؤتمرات ومعارض مع فريق فعاليات وضيافة إرث.',
  weddings: 'Ballroom, gardens, and contemporary catering, a premier regional wedding venue.',
} as const

export const ARABIC_GREETING =
  'أهلاً بكم في حجوزات إرث أبوظبي. أنا مساعد ذكي. كيف يمكنني مساعدتكم: حجز، تعديل، مطعم، سبا، أو التحدث مع زميل؟'

export const ENGLISH_GREETING =
  'Welcome to Erth Abu Dhabi reservations. I’m an AI assistant. How may I help: a reservation, a change, dining, spa, or a colleague?'

export const FAQ_ANSWERS: Record<string, { en: string; ar: string }> = {
  check_in: {
    en: `Check-in from ${RESORT.checkInTime}, check-out by ${RESORT.checkOutTime}. Late arrivals welcome, share your ETA.`,
    ar: `الوصول من ${RESORT.checkInTime} والمغادرة قبل ${RESORT.checkOutTime}.`,
  },
  location: { en: RESORT.location, ar: 'خور المقطع، طريق الخليج العربي، أبوظبي.' },
  dining: {
    en: `Al Rimal, Ergon, Asrah, Beetza, Erth Al Hosn (Michelin). ${RESORT.diningPhone}`,
    ar: `الرمال، إرغون، أسرح، بيتزا، وإرث الحصن.`,
  },
  spa: {
    en: `${WELLNESS.spa.name}: ${WELLNESS.spa.hours}. ${WELLNESS.spa.en}`,
    ar: WELLNESS.spa.ar,
  },
  after_hours: {
    en: `I can take your request and notify reservations (${RESORT.reservationsPhone}).`,
    ar: `يمكنني تسجيل طلبكم وإشعار الحجوزات.`,
  },
}
