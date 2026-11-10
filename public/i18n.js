'use strict';

/* ─────────────────────────────────────────────────────────────
   Tonight's Movie — tiny i18n layer (English / Arabic)
   Film titles and Letterboxd data stay in their original language;
   the interface, genre names, country names and synopses are localised.
   ───────────────────────────────────────────────────────────── */

const I18N = (() => {
  const STORAGE_KEY = 'tonights-movie:lang';
  const listeners = new Set();
  let lang = 'en';

  const dict = {
    en: {
      'meta.title': "Tonight's Movie — random film picker for any Letterboxd list",
      'meta.description':
        'Free random film picker for Letterboxd: pick from any public watchlist or list, with genre, rating, runtime, decade and country filters. No login required.',

      'brand.name': "Tonight's <em>Movie</em>",
      'theme.toLight': 'Switch to light theme',
      'theme.toDark': 'Switch to dark theme',
      'lang.switch': 'Switch to Arabic',
      'user.title': 'Load a different list',
      'user.listChip': 'list: {name}',

      'landing.eyebrow': 'A random film picker for Letterboxd',
      'landing.title': 'Stop scrolling.<br /><em>Start watching.</em>',
      'landing.lede':
        'Pick one random film from any public Letterboxd list — your watchlist or any curated list. Add a few filters if tonight has a mood.',
      'landing.usernameLabel': 'Letterboxd username or list link',
      'landing.placeholder': 'your-letterboxd-name',
      'landing.submit': 'Load list',
      'landing.demo': 'Try the 84-film demo',
      'landing.hint': 'Public lists only · no login',

      'loading.eyebrow': 'One moment',
      'loading.title': 'Reading your list…',
      'loading.sub': 'Loading every page of the list — not just the first one.',
      'loading.subMulti': 'Loading every page so the reel has the whole list.',
      'loading.subSingle': 'Reading the list.',
      'loading.starting': 'Starting…',
      'loading.cancel': 'Cancel',
      'loading.detailsTitle': 'Preparing the reel…',
      'loading.detailsSub': 'Reading film details in the background.',
      'loading.pageOne': '{page} of {total} page · {films} films',
      'loading.pageMany': '{page} of {total} pages · {films} films',
      'loading.filmsCount': '{done} of {total} films',
      'app.kickerPrefix': '',
      'app.kickerSuffix': '’s watchlist · {total} films',
      'app.kickerListPrefix': '',
      'app.kickerListSuffix': ' — a list by {owner} · {total} films',
      'app.poolOne': 'film in the reel',
      'app.poolMany': 'films in the reel',
      'app.filters': 'Filters',
      'app.activeOne': '1 active',
      'app.activeMany': '{count} active',
      'app.genre': 'Genre',
      'app.rating': 'Rating',
      'app.ratingHint': 'Lowest rating',
      'app.runtime': 'Runtime',
      'app.runtimeHint': 'Longest allowed',
      'app.upTo': 'Up to {value}',
      'app.noRuntime': 'No runtime data was available for these films.',
      'app.decade': 'Decade',
      'app.country': 'Country',
      'app.genreMode': 'Genre match mode',
      'app.any': 'Any',
      'app.modeAny': 'Any',
      'app.modeAll': 'All',
      'app.clearAll': 'Clear all filters',
      'app.clear': 'Clear filters',
      'app.pickAnother': 'Pick another film',
      'app.emptyTitle': 'No films match those filters.',
      'app.emptySub': 'Try a lower rating, a longer runtime, or fewer genres.',
      'app.filterLoadingTitle': 'Reading film details so filters can work.',
      'app.filterLoadingNote':
        'You can already pick a film — filters unlock when the details finish.',
      'app.filterUnavailable':
        'Film details could not be read, so filters are unavailable. Picking still works.',
      'app.detailsPreparing': 'Preparing filters…',
      'app.detailsInitial': 'Preparing your first pick…',
      'app.detailsOffline':
        'Lost the details connection. Picking still works with what was loaded — reload the list to finish enriching.',
      'app.detailsReading': 'Reading details · {done} / {total}',
      'app.noGenres': 'No genre data was available for these films.',
      'app.decadeChip': '{year}s',

      'pick.noteLoading': 'You can pick right away — details are still loading.',
      'pick.tonight': 'Tonight’s pick',
      'pick.directedBy': 'Directed by {names}',
      'pick.viewOn': 'View on Letterboxd',
      'pick.noSynopsis': 'No synopsis available.',
      'pick.readingDetails': 'Reading this film’s details…',
      'pick.detailsLoading': 'Details loading…',
      'pick.detailsUnavailable': 'Details unavailable for this film.',
      'pick.ratingsOne': '{count} Letterboxd rating',
      'pick.ratingsMany': '{count} Letterboxd ratings',
      'pick.posterAlt': 'Poster for {title}',
      'pick.translated': 'Machine translation',
      'pick.countryMore': '{name}, and others',

      'runtime.hours': '{hours}h',
      'runtime.hoursMinutes': '{hours}h {minutes}m',
      'runtime.minutes': '{minutes}m',

      'announce.picked': 'Picked {title}{year}.',
      'announce.loaded': 'List loaded with {total} films. Details are still loading.',
      'announce.ready':
        'All film details ready. {count} films in the reel. Filters are available.',
      'announce.noMatch': 'No films match these filters.',

      'error.inputEmpty': 'Enter a Letterboxd username or paste a list link first.',
      'error.inputInvalid':
        "That doesn't look like a Letterboxd username or list link. Try just the username, or paste the full list URL.",
      'error.userNotFound': "Couldn't find that Letterboxd user. Check the username and try again.",
      'error.listNotFound': "Couldn't find that Letterboxd list. Check the link — or that it's public.",
      'error.privateWatchlist': 'That watchlist is private. Make it public on Letterboxd first.',
      'error.emptyWatchlist': 'That watchlist is empty (or not visible). Add a film or make the list public.',
      'error.emptyList': 'That list is empty (or not visible).',
      'error.rateLimited': 'Letterboxd is rate limiting requests right now. Try again in a minute.',
      'error.loadFailed': 'That list could not be read. Try again.',
      'error.couldNotLoad': 'Could not load that list.',
      'error.serverDown': 'Could not reach the server. Check that it is running and try again.',
      'error.demoMissing': 'The demo dataset is missing.',

      'toast.retry': 'Connection interrupted. Retrying…',

      'footer.text':
        'An independent project for film lovers by <a href="https://letterboxd.com/JustLOAY" target="_blank" rel="noreferrer">JustLOAY</a> — not affiliated with <a href="https://letterboxd.com" target="_blank" rel="noreferrer">Letterboxd</a>.',

      genres: {
        Action: 'Action',
        Adventure: 'Adventure',
        Animation: 'Animation',
        Comedy: 'Comedy',
        Crime: 'Crime',
        Documentary: 'Documentary',
        Drama: 'Drama',
        Family: 'Family',
        Fantasy: 'Fantasy',
        'Film-Noir': 'Film-Noir',
        History: 'History',
        Horror: 'Horror',
        Music: 'Music',
        Mystery: 'Mystery',
        Romance: 'Romance',
        'Science Fiction': 'Science Fiction',
        Short: 'Short',
        Thriller: 'Thriller',
        'TV Movie': 'TV Movie',
        War: 'War',
        Western: 'Western',
      },

      countries: {},
    },

    ar: {
      'meta.title': 'فيلم الليلة — اختيار فيلم عشوائي من أي قائمة ليتربوكسد',
      'meta.description':
        'مجاني: اختر فيلمًا عشوائيًا من أي قائمة مشاهدة أو قائمة أفلام عامة على ليتربوكسد، مع فلاتر للتصنيف والتقييم والمدة والعقد والبلد. بدون تسجيل دخول.',

      'brand.name': 'فيلم <em>الليلة</em>',
      'theme.toLight': 'التبديل إلى الوضع الفاتح',
      'theme.toDark': 'التبديل إلى الوضع الداكن',
      'lang.switch': 'Switch to English',
      'user.title': 'تحميل قائمة أخرى',
      'user.listChip': 'قائمة: {name}',

      'landing.eyebrow': 'اختيار فيلم عشوائي من قوائم ليتربوكسد',
      'landing.title': 'توقّف عن التمرير.<br /><em>ابدأ المشاهدة.</em>',
      'landing.lede':
        'اختر فيلمًا عشوائيًا واحدًا من أي قائمة عامة على ليتربوكسد — قائمة مشاهدتك أو أي قائمة أخرى. أضف بعض الفلاتر إذا كان لليلتك مزاج معيّن.',
      'landing.usernameLabel': 'اسم المستخدم أو رابط قائمة في ليتربوكسد',
      'landing.placeholder': 'اسم-حسابك-في-ليتربوكسد',
      'landing.submit': 'حمّل القائمة',
      'landing.demo': 'جرّب الديمو (84 فيلمًا)',
      'landing.hint': 'قوائم عامة فقط · بدون تسجيل دخول',

      'loading.eyebrow': 'لحظة واحدة',
      'loading.title': 'نقرأ قائمتك…',
      'loading.sub': 'نحمّل كل صفحات القائمة — وليس الصفحة الأولى فقط.',
      'loading.subMulti': 'نحمّل كل الصفحات حتى تضم القائمة كل أفلامها.',
      'loading.subSingle': 'نقرأ القائمة.',
      'loading.starting': 'نبدأ…',
      'loading.cancel': 'إلغاء',
      'loading.detailsTitle': 'نجهّز القائمة…',
      'loading.detailsSub': 'نقرأ تفاصيل الأفلام في الخلفية.',
      'loading.pageOne': '{page} من {total} · {films} فيلم',
      'loading.pageMany': '{page} من {total} صفحات · {films} فيلم',
      'loading.filmsCount': '{done} من {total} فيلم',

      'app.kickerPrefix': 'قائمة مشاهدة ',
      'app.kickerSuffix': ' فيها {total} فيلمًا',
      'app.kickerListPrefix': 'قائمة ',
      'app.kickerListSuffix': ' من إعداد {owner} فيها {total} فيلمًا',
      'app.poolOne': 'فيلم في القائمة',
      'app.poolMany': 'أفلام في القائمة',
      'app.filters': 'الفلاتر',
      'app.activeOne': 'فلتر واحد',
      'app.activeMany': '{count} فلاتر',
      'app.genre': 'التصنيف',
      'app.rating': 'التقييم',
      'app.ratingHint': 'أدنى تقييم',
      'app.runtime': 'المدة',
      'app.runtimeHint': 'أقصى مدة مسموحة',
      'app.upTo': 'حتى {value}',
      'app.noRuntime': 'لا تتوفر بيانات مدة لهذه الأفلام.',
      'app.decade': 'العقد',
      'app.country': 'البلد',
      'app.genreMode': 'طريقة مطابقة التصنيف',
      'app.any': 'الكل',
      'app.modeAny': 'أي',
      'app.modeAll': 'كلها',
      'app.clearAll': 'مسح كل الفلاتر',
      'app.clear': 'مسح الفلاتر',
      'app.pickAnother': 'اختر فيلمًا آخر',
      'app.emptyTitle': 'لا توجد أفلام مطابقة لهذه الفلاتر.',
      'app.emptySub': 'جرّب تقييمًا أقل، أو مدة أطول، أو تصنيفات أقل.',
      'app.filterLoadingTitle': 'نقرأ تفاصيل الأفلام حتى تعمل الفلاتر.',
      'app.filterLoadingNote': 'يمكنك الاختيار الآن — تُفتح الفلاتر عند اكتمال التفاصيل.',
      'app.filterUnavailable':
        'تعذّرت قراءة تفاصيل الأفلام، لذا الفلاتر غير متاحة. الاختيار ما زال يعمل.',
      'app.detailsPreparing': 'نجهّز الفلاتر…',
      'app.detailsInitial': 'نجهّز اختيارك الأول…',
      'app.detailsOffline':
        'انقطع اتصال التفاصيل. الاختيار يعمل بما اكتمل تحميله — أعد تحميل القائمة لاستكمال القراءة.',
      'app.detailsReading': 'نقرأ التفاصيل · {done} من {total}',
      'app.noGenres': 'لا تتوفر بيانات تصنيفات لهذه الأفلام.',
      'app.decadeChip': '{year}s',

      'pick.noteLoading': 'يمكنك الاختيار الآن — التفاصيل ما زالت تُقرأ.',
      'pick.tonight': 'اختيار الليلة',
      'pick.directedBy': 'إخراج {names}',
      'pick.viewOn': 'عرض على ليتربوكسد',
      'pick.noSynopsis': 'لا يوجد ملخص متاح.',
      'pick.readingDetails': 'نقرأ تفاصيل هذا الفيلم…',
      'pick.detailsLoading': 'التفاصيل تُحمّل…',
      'pick.detailsUnavailable': 'التفاصيل غير متاحة لهذا الفيلم.',
      'pick.ratingsOne': 'تقييم واحد على ليتربوكسد',
      'pick.ratingsMany': '{count} تقييم على ليتربوكسد',
      'pick.posterAlt': 'بوستر فيلم {title}',
      'pick.translated': 'ترجمة آلية',
      'pick.countryMore': '{name} ودول أخرى',

      'runtime.hours': '{hours} س',
      'runtime.hoursMinutes': '{hours} س {minutes} د',
      'runtime.minutes': '{minutes} د',

      'announce.picked': 'تم اختيار {title}{year}.',
      'announce.loaded': 'تم تحميل القائمة وفيها {total} فيلمًا. التفاصيل ما زالت تُقرأ.',
      'announce.ready':
        'اكتملت تفاصيل الأفلام. {count} فيلمًا في القائمة. الفلاتر متاحة الآن.',
      'announce.noMatch': 'لا توجد أفلام مطابقة لهذه الفلاتر.',

      'error.inputEmpty': 'أدخل اسم مستخدم أو الصق رابط قائمة على ليتربوكسد أولًا.',
      'error.inputInvalid':
        'يبدو أن هذا ليس اسم مستخدم أو رابط قائمة صحيح. جرّب اسم المستخدم وحده أو الصق رابط القائمة كاملًا.',
      'error.userNotFound': 'ما لقينا مستخدم بهذا الاسم.',
      'error.listNotFound': 'ما لقينا هذه القائمة. تأكد من الرابط أو أن القائمة عامة.',
      'error.privateWatchlist': 'قائمة المشاهدة هذه خاصة. اجعلها عامة على ليتربوكسد أولًا.',
      'error.emptyWatchlist': 'قائمة المشاهدة فارغة (أو غير ظاهرة). أضف فيلمًا أو اجعلها عامة.',
      'error.emptyList': 'هذه القائمة فارغة (أو غير ظاهرة).',
      'error.rateLimited': 'ليتربوكسد يحظر الطلبات مؤقتًا الآن. حاول بعد دقيقة.',
      'error.loadFailed': 'تعذّرت قراءة هذه القائمة. حاول مرة أخرى.',
      'error.couldNotLoad': 'تعذّر تحميل هذه القائمة.',
      'error.serverDown': 'تعذّر الوصول إلى الخادم. تأكد أنه يعمل ثم حاول مرة أخرى.',
      'error.demoMissing': 'بيانات الديمو غير موجودة.',

      'toast.retry': 'انقطع الاتصال. نحاول مرة أخرى…',

      'footer.text':
        'مشروع مستقل لعشّاق السينما من إعداد <a href="https://letterboxd.com/JustLOAY" target="_blank" rel="noreferrer">JustLOAY</a> — غير تابع <a href="https://letterboxd.com" target="_blank" rel="noreferrer">لليتربوكسد</a>.',

      genres: {
        Action: 'أكشن',
        Adventure: 'مغامرة',
        Animation: 'أنيميشن',
        Comedy: 'كوميديا',
        Crime: 'جريمة',
        Documentary: 'وثائقي',
        Drama: 'دراما',
        Family: 'عائلي',
        Fantasy: 'فانتازيا',
        'Film-Noir': 'فيلم نوار',
        History: 'تاريخي',
        Horror: 'رعب',
        Music: 'موسيقي',
        Mystery: 'غموض',
        Romance: 'رومانسي',
        'Science Fiction': 'خيال علمي',
        Short: 'قصير',
        Thriller: 'إثارة',
        'TV Movie': 'فيلم تلفزيوني',
        War: 'حرب',
        Western: 'غربي',
      },

      countries: {
        Afghanistan: 'أفغانستان',
        Albania: 'ألبانيا',
        Algeria: 'الجزائر',
        'American Samoa': 'ساموا الأمريكية',
        Andorra: 'أندورا',
        Angola: 'أنغولا',
        Argentina: 'الأرجنتين',
        Armenia: 'أرمينيا',
        Aruba: 'أروبا',
        Australia: 'أستراليا',
        Austria: 'النمسا',
        Azerbaijan: 'أذربيجان',
        Bahamas: 'الباهاما',
        Bahrain: 'البحرين',
        Bangladesh: 'بنغلاديش',
        Barbados: 'بربادوس',
        Belarus: 'بيلاروسيا',
        Belgium: 'بلجيكا',
        Belize: 'بليز',
        Benin: 'بنين',
        Bermuda: 'برمودا',
        Bhutan: 'بوتان',
        Bolivia: 'بوليفيا',
        'Bosnia and Herzegovina': 'البوسنة والهرسك',
        Botswana: 'بوتسوانا',
        Brazil: 'البرازيل',
        Brunei: 'بروناي',
        Bulgaria: 'بلغاريا',
        'Burkina Faso': 'بوركينا فاسو',
        Burundi: 'بوروندي',
        Cambodia: 'كمبوديا',
        Cameroon: 'الكاميرون',
        Canada: 'كندا',
        'Cape Verde': 'الرأس الأخضر',
        Chad: 'تشاد',
        Chile: 'تشيلي',
        China: 'الصين',
        Colombia: 'كولومبيا',
        'Costa Rica': 'كوستاريكا',
        Croatia: 'كرواتيا',
        Cuba: 'كوبا',
        Cyprus: 'قبرص',
        Czechia: 'التشيك',
        'Czech Republic': 'التشيك',
        Czechoslovakia: 'تشيكوسلوفاكيا',
        Denmark: 'الدنمارك',
        Djibouti: 'جيبوتي',
        'Dominican Republic': 'جمهورية الدومينيكان',
        'East Germany': 'ألمانيا الشرقية',
        Ecuador: 'الإكوادور',
        Egypt: 'مصر',
        'El Salvador': 'السلفادور',
        England: 'إنجلترا',
        'Equatorial Guinea': 'غينيا الاستوائية',
        Eritrea: 'إريتريا',
        Estonia: 'إستونيا',
        Eswatini: 'إسواتيني',
        Ethiopia: 'إثيوبيا',
        'Faroe Islands': 'جزر فارو',
        Fiji: 'فيجي',
        Finland: 'فنلندا',
        France: 'فرنسا',
        'French Guiana': 'غيانا الفرنسية',
        Gabon: 'الغابون',
        Gambia: 'غامبيا',
        Georgia: 'جورجيا',
        Germany: 'ألمانيا',
        Ghana: 'غانا',
        Greece: 'اليونان',
        Greenland: 'جرينلاند',
        Grenada: 'غرينادا',
        Guadeloupe: 'غوادلوب',
        Guam: 'غوام',
        Guatemala: 'غواتيمالا',
        Guinea: 'غينيا',
        'Guinea-Bissau': 'غينيا بيساو',
        Guyana: 'غيانا',
        Haiti: 'هايتي',
        Honduras: 'هندوراس',
        'Hong Kong': 'هونغ كونغ',
        Hungary: 'المجر',
        Iceland: 'آيسلندا',
        India: 'الهند',
        Indonesia: 'إندونيسيا',
        Iran: 'إيران',
        Iraq: 'العراق',
        Ireland: 'أيرلندا',
        Israel: 'إسرائيل',
        Italy: 'إيطاليا',
        'Ivory Coast': 'ساحل العاج',
        Jamaica: 'جامايكا',
        Japan: 'اليابان',
        Jordan: 'الأردن',
        Kazakhstan: 'كازاخستان',
        Kenya: 'كينيا',
        Kosovo: 'كوسوفو',
        Kuwait: 'الكويت',
        Kyrgyzstan: 'قيرغيزستان',
        Laos: 'لاوس',
        Latvia: 'لاتفيا',
        Lebanon: 'لبنان',
        Lesotho: 'ليسوتو',
        Liberia: 'ليبيريا',
        Libya: 'ليبيا',
        Liechtenstein: 'ليختنشتاين',
        Lithuania: 'ليتوانيا',
        Luxembourg: 'لوكسمبورغ',
        Macau: 'ماكاو',
        Macedonia: 'مقدونيا',
        'North Macedonia': 'مقدونيا الشمالية',
        Madagascar: 'مدغشقر',
        Malawi: 'مالاوي',
        Malaysia: 'ماليزيا',
        Maldives: 'المالديف',
        Mali: 'مالي',
        Malta: 'مالطا',
        Martinique: 'مارتينيك',
        Mauritania: 'موريتانيا',
        Mauritius: 'موريشيوس',
        Mexico: 'المكسيك',
        Moldova: 'مولدوفا',
        Monaco: 'موناكو',
        Mongolia: 'منغوليا',
        Montenegro: 'الجبل الأسود',
        Morocco: 'المغرب',
        Mozambique: 'موزمبيق',
        Myanmar: 'ميانمار',
        Namibia: 'ناميبيا',
        Nepal: 'نيبال',
        Netherlands: 'هولندا',
        'Netherlands Antilles': 'جزر الأنتيل الهولندية',
        'New Zealand': 'نيوزيلندا',
        Nicaragua: 'نيكاراغوا',
        Niger: 'النيجر',
        Nigeria: 'نيجيريا',
        'North Korea': 'كوريا الشمالية',
        'Northern Ireland': 'أيرلندا الشمالية',
        Norway: 'النرويج',
        Oman: 'عُمان',
        Pakistan: 'باكستان',
        Palestine: 'فلسطين',
        Panama: 'بنما',
        'Papua New Guinea': 'بابوا غينيا الجديدة',
        Paraguay: 'باراغواي',
        Peru: 'بيرو',
        Philippines: 'الفلبين',
        Poland: 'بولندا',
        Portugal: 'البرتغال',
        'Puerto Rico': 'بورتوريكو',
        Qatar: 'قطر',
        'Republic of the Congo': 'جمهورية الكونغو',
        'Democratic Republic of the Congo': 'جمهورية الكونغو الديمقراطية',
        Romania: 'رومانيا',
        Russia: 'روسيا',
        Rwanda: 'رواندا',
        'Saudi Arabia': 'السعودية',
        Scotland: 'اسكتلندا',
        Senegal: 'السنغال',
        Serbia: 'صربيا',
        Seychelles: 'سيشل',
        'Sierra Leone': 'سيراليون',
        Singapore: 'سنغافورة',
        Slovakia: 'سلوفاكيا',
        Slovenia: 'سلوفينيا',
        Somalia: 'الصومال',
        'South Africa': 'جنوب أفريقيا',
        'South Korea': 'كوريا الجنوبية',
        'State of Palestine': 'فلسطين',
        'Soviet Union': 'الاتحاد السوفيتي',
        USSR: 'الاتحاد السوفيتي',
        USA: 'الولايات المتحدة',
        UK: 'المملكة المتحدة',
        Spain: 'إسبانيا',
        'Sri Lanka': 'سريلانكا',
        Sudan: 'السودان',
        Suriname: 'سورينام',
        Sweden: 'السويد',
        Switzerland: 'سويسرا',
        Syria: 'سوريا',
        Taiwan: 'تايوان',
        Tajikistan: 'طاجيكستان',
        Tanzania: 'تنزانيا',
        Thailand: 'تايلاند',
        Togo: 'توغو',
        'Trinidad and Tobago': 'ترينيداد وتوباغو',
        Tunisia: 'تونس',
        Turkey: 'تركيا',
        Turkmenistan: 'تركمانستان',
        Uganda: 'أوغندا',
        Ukraine: 'أوكرانيا',
        'United Arab Emirates': 'الإمارات العربية المتحدة',
        'United Kingdom': 'المملكة المتحدة',
        'United States': 'الولايات المتحدة',
        Uruguay: 'أوروغواي',
        Uzbekistan: 'أوزبكستان',
        Venezuela: 'فنزويلا',
        Vietnam: 'فيتنام',
        Wales: 'ويلز',
        'West Germany': 'ألمانيا الغربية',
        Yemen: 'اليمن',
        Yugoslavia: 'يوغوسلافيا',
        Zambia: 'زامبيا',
        Zimbabwe: 'زيمبابوي',
      },
    },
  };

  function interpolate(template, vars) {
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    );
  }

  function t(key, vars) {
    const table = dict[lang] || dict.en;
    const value = table[key] ?? dict.en[key] ?? key;
    return interpolate(value, vars);
  }

  function genre(name) {
    const table = dict[lang] || dict.en;
    return table.genres?.[name] || name;
  }

  function country(name) {
    const table = dict[lang] || dict.en;
    return table.countries?.[name] || name;
  }

  function isArabicTag(tag) {
    return /^ar\b/i.test(String(tag || ''));
  }

  function detect() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'ar' || stored === 'en') return stored;
    } catch {
      // localStorage can be unavailable in private modes.
    }
    const tags =
      Array.isArray(navigator.languages) && navigator.languages.length
        ? navigator.languages
        : [navigator.language || 'en'];
    return tags.some(isArabicTag) ? 'ar' : 'en';
  }

  function applyStatic() {
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach((node) => {
      node.innerHTML = t(node.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.setAttribute('title', t(node.dataset.i18nTitle));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
      node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
    });
  }

  function apply() {
    const root = document.documentElement;
    root.setAttribute('lang', lang);
    root.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    document.title = t('meta.title');
    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', t('meta.description'));
    applyStatic();
  }

  function setLang(next, { silent = false } = {}) {
    const value = next === 'ar' ? 'ar' : 'en';
    if (value === lang && !silent) {
      apply();
      return;
    }
    lang = value;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Ignore storage failures.
    }
    apply();
    for (const listener of listeners) listener(lang);
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  lang = detect();

  return {
    t,
    genre,
    country,
    setLang,
    getLang: () => lang,
    detect,
    apply,
    onChange,
    isArabic: () => lang === 'ar',
  };
})();

// `const` at the top level does not create a window property, so expose it
// explicitly for the deferred app script.
window.I18N = I18N;
