/**
 * GPX Libre 150, product facts sourced from the official page:
 * https://gpxinternational.com/libre150/
 * Labelled DEMO / SAMPLE for sales demos. Not affiliated with GP Motor.
 */

export const LIBRE150 = {
  brand: 'GPX',
  model: 'Libre 150',
  fullName: 'GPX Libre 150',
  tagline: 'Street-ready 149.4cc, colors inspired',
  officialUrl: 'https://gpxinternational.com/libre150/',
  sourceNote: 'Specs from gpxinternational.com/libre150 (demo knowledge pack)',

  /** Colors shown on official page */
  colors: [
    { id: 'grey', label: { en: 'Grey', ar: 'رمادي' } },
    { id: 'grey_red', label: { en: 'Grey Red', ar: 'رمادي أحمر' } },
  ],

  engine: {
    type: { en: '4-stroke (4T), SOHC', ar: 'رباعي الأشواط (4T)، SOHC' },
    displacement: '149.4 cc',
    fuelSystem: { en: 'Carburetor', ar: 'كاربوراتير' },
    cooling: { en: 'Air-cooled', ar: 'تبريد هوائي' },
    transmission: { en: '6-speed manual gearbox', ar: 'ناقل حركة يدوي 6 سرعات' },
    summary: {
      en: 'Powered by a 149.4cc carburetor engine with a smooth 6-speed transmission, responsive power, balanced torque, and refined control for every riding style.',
      ar: 'محرك 149.4 سي سي كاربيراتير مع ناقل 6 سرعات سلس, قوة متجاوبة وعزم متوازن وتحكم دقيق لكل أسلوب قيادة.',
    },
  },

  chassis: {
    frontSuspension: {
      en: 'Telescopic front suspension, enhances front-end stability and precise handling for a sportier, more confident feel.',
      ar: 'تعليق أمامي تلسكوبي, يعزز ثبات المقدمة والتحكم الدقيق لإحساس رياضي أكثر ثقة.',
    },
    rearSuspension: {
      en: 'Dual rear shock absorbers, absorb road impacts for a smoother, more stable ride with better comfort and control. (Listed as “Duel Rear Shock Absorbers” on the official page.)',
      ar: 'ممتصا صدمات خلفيان مزدوجان, يمتصان اهتزاز الطريق لرحلة أوضح وأكثر ثباتاً وراحة.',
    },
    frontBrake: { en: 'Disc brake', ar: 'فرامل قرصية أمامية' },
    rearBrake: { en: 'Drum brake', ar: 'فرامل طبلة خلفية' },
    brakingSummary: {
      en: 'Braking system delivers confident stopping power, improved stability, and better control in every riding condition. Front disc + rear drum.',
      ar: 'نظام الفرملة يوفّر قوة توقف واثقة وثباتاً وتحكماً أفضل في مختلف الظروف. قرص أمامي وطبلة خلفية.',
    },
    wheels: { en: 'Aluminum alloy wheels', ar: 'جنوط ألمنيوم' },
    frontTire: '80/90-17″',
    rearTire: '100/90-17″',
    wheelSummary: {
      en: 'Lightweight aluminum alloy wheels enhance handling, stability, and riding control with a sleek sporty look. Front 80/90-17″ · Rear 100/90-17″.',
      ar: 'جنوط ألمنيوم خفيفة تعزز التحكم والثبات بمظهر رياضي. أمامي 80/90-17″ · خلفي 100/90-17″.',
    },
  },

  dimensions: {
    seatHeight: '775 mm',
    wheelbase: '1280 mm',
    wetWeight: '125 kg',
    fuelTank: '17 L',
  },

  instruments: {
    en: 'LCD meter / digital display',
    ar: 'عداد LCD رقمي',
  },

  features: {
    ledFront: {
      en: 'Signature LED front light, distinctive LED layout for modern style, clear visibility, and confident road presence.',
      ar: 'ضوء أمامي LED مميز, تصميم إضاءة عصري ورؤية واضحة وحضور قوي على الطريق.',
    },
    ledRear: {
      en: 'Sharp LED rear light, better visibility from behind with a modern sporty rear profile.',
      ar: 'ضوء خلفي LED حاد, رؤية أفضل من الخلف مع مظهر خلفي رياضي عصري.',
    },
    exhaust: {
      en: 'Compact sport-style exhaust, bold look with a clean, dynamic design matching the bike’s aggressive character.',
      ar: 'عادم رياضي مدمج, مظهر جريء وتصميم ديناميكي يناسب الطابع الهجومي للدراجة.',
    },
    graphics: {
      en: 'Dynamic side-body graphics, sharper, more distinctive street look.',
      ar: 'رسومات جانبية ديناميكية, مظهر شارع أوضح وأكثر تميزاً.',
    },
    seat: {
      en: 'Premium textured seat, everyday comfort, better support, clean sporty finish.',
      ar: 'مقعد بقماش فاخر محكم, راحة يومية ودعم أفضل ولمسة رياضية.',
    },
    design: {
      en: 'New street-ready design, aggressive character with premium, rugged detailing from every angle.',
      ar: 'تصميم شارع جديد, طابع هجومي مع تفاصيل فاخرة ومتينة من كل زاوية.',
    },
  },

  /** Demo dealer / showroom framing (not official GPX dealer claim) */
  dealer: {
    name: 'Gulf GPX Demo Showroom',
    propertyLabel: 'GPX Libre 150, Sales & Product AI (Demo)',
    tagline: 'Demo stand-in for motorcycle dealer after-hours / overflow',
    city: 'Abu Dhabi / Gulf (demo)',
    phone: '+971 2 XXX XXXX',
    whatsappDesk: '+971 50 XXX XXXX',
    emailDesk: 'sales-demo@gpx-showroom.example',
    opens: '09:00',
    closes: '21:00',
    location: {
      en: 'Demo showroom, Gulf region. Share your city and a sales advisor will confirm the nearest partner. Official product page: gpxinternational.com/libre150',
      ar: 'صالة عرض تجريبية, منطقة الخليج. أخبرونا بمدينتكم وسيتواصل مستشار المبيعات بأقرب شريك. الصفحة الرسمية: gpxinternational.com/libre150',
    },
    serviceHours: {
      en: 'Workshop / service desk (demo): Sat–Thu 09:00–18:00. I can take a service booking request after hours.',
      ar: 'ورشة الخدمة (تجريبي): السبت–الخميس 09:00–18:00. يمكنني تسجيل طلب صيانة خارج الدوام.',
    },
  },

  /** Pricing intentionally placeholder, dealers set local retail */
  pricing: {
    en: 'Retail price is set by your local GPX partner and may include registration, insurance, or promotions. I don’t invent a number in this demo, I can take your city and phone so sales can quote the current Libre 150 offer.',
    ar: 'سعر البيع يحدده الشريك المحلي وقد يشمل التسجيل أو التأمين أو العروض. لا أذكر رقماً وهمياً في هذا العرض, يمكنني تسجيل مدينتكم ورقمكم ليتواصل المبيعات بعرض Libre 150 الحالي.',
  },

  warranty: {
    en: 'Warranty terms follow your local GPX distributor / dealer policy (demo). Ask sales for the warranty card duration and what is covered for engine, electrical, and frame.',
    ar: 'الضمان وفق سياسة الموزع/الوكيل المحلي (تجريبي). اسألوا المبيعات عن مدة بطاقة الضمان وما يشمله المحرك والكهرباء والشاسيه.',
  },

  fuelEconomy: {
    en: 'Official page highlights a 17L fuel tank. Exact km/L depends on riding style, load, and maintenance, sales can share typical owner figures for your market.',
    ar: 'الصفحة الرسمية تذكر خزان 17 لتراً. استهلاك اللتر يعتمد على أسلوب القيادة والحمل والصيانة, المبيعات يمكنه مشاركة أرقام تقريبية لسوقكم.',
  },

  comparison: {
    en: 'Libre 150 sits in the ~150cc street segment: 6-speed gearbox, disc front brake, dual rear shocks, LED lighting, LCD meter, 125 kg. Ideal if you want a sporty street look with everyday practicality.',
    ar: 'Libre 150 في فئة دراجات الشارع ~150 سي سي: 6 سرعات، فرامل قرصية أمامية، صدمات خلفية مزدوجة، إضاءة LED، عداد LCD، وزن 125 كغ. مناسبة إن أردتم مظهراً رياضياً مع استخدام يومي.',
  },

  testRide: {
    en: 'Test rides depend on local dealer availability, licence, and deposit rules. Share your name, phone, preferred day, and city, I’ll notify the sales desk to confirm a slot.',
    ar: 'التجربة تعتمد على توفر الوكيل والرخصة وقواعد التأمين. أرسلوا الاسم والهاتف واليوم المفضل والمدينة, سأُشعر المبيعات لتأكيد الموعد.',
  },

  documents: {
    en: 'Typical purchase docs (demo / varies by country): valid ID, driving licence for the class, and payment method. Finance options if offered by the local partner.',
    ar: 'مستندات الشراء المعتادة (تجريبي وتختلف حسب الدولة): هوية سارية، رخصة من الفئة المناسبة، وطريقة الدفع. التمويل إن وفّره الشريك المحلي.',
  },

  spareParts: {
    en: 'Genuine parts and accessories through authorized partners. I can log a parts request (filter, pads, chain, graphics kit, etc.) for the parts desk to call you back.',
    ar: 'قطع أصلية وإكسسوارات عبر الشركاء المعتمدين. يمكنني تسجيل طلب قطع (فلتر، فحمات، سلسلة، رسومات…) ليتواصل قسم القطع معكم.',
  },

  maintenance: {
    en: 'Follow the user manual service intervals (oil, chain, plugs, valves as applicable for SOHC air-cooled). Demo tip: first service often earlier than regular intervals, confirm with your workshop.',
    ar: 'اتبعوا فترات الصيانة في دليل المستخدم (زيت، سلسلة، بواجي، صمامات حسب محرك SOHC المبرد بالهواء). غالباً تكون الصيانة الأولى أبكر, أكّدوا مع الورشة.',
  },
} as const

export const GPX_GREETING_EN =
  'Good evening, welcome to the GPX Libre 150 sales line. I am an AI assistant for after-hours and overflow enquiries. This is a demonstration. I can share Libre 150 specs, colours, features, help book a test ride or purchase callback, service or parts, or connect you to a sales colleague.'

export const GPX_GREETING_AR =
  'مساء الخير، أهلاً بكم في خط مبيعات GPX Libre 150. أنا مساعد ذكي للرد خارج أوقات الذروة وعند امتلاء الخط. هذه محادثة تجريبية. يمكنني مشاركة المواصفات والألوان والمميزات، أو حجز تجربة قيادة / اتصال مبيعات، أو صيانة وقطع، أو توصيلكم بمستشار مبيعات.'
