/**
 * The sentence a voice is tried out with, in the language it will speak:
 * a Chinese voice is heard saying Chinese, not English with an accent. One
 * fixed sentence per language, written here rather than asked of a model,
 * so the sample is instant and always the same. A language without one
 * falls back to English — the voice still plays, and the vendor's
 * multilingual voices read it well.
 */

const ENGLISH = 'Hello — this is how replies will sound in your chats.';

/** By language subtag; a full tag wins where one language is written two ways. */
const PHRASES: Record<string, string> = {
  en: ENGLISH,
  af: 'Hallo. So sal antwoorde in jou geselsies klink.',
  am: 'ሰላም። በውይይቶችዎ ውስጥ መልሶች እንዲህ ይሰማሉ።',
  ar: 'مرحبًا. هكذا ستبدو الردود في محادثاتك.',
  az: 'Salam. Söhbətlərinizdə cavablar belə səslənəcək.',
  bg: 'Здравейте. Така ще звучат отговорите във вашите чатове.',
  bn: 'নমস্কার। আপনার চ্যাটে উত্তরগুলি এভাবে শোনা যাবে।',
  bs: 'Zdravo. Ovako će zvučati odgovori u vašim razgovorima.',
  ca: 'Hola. Així sonaran les respostes als teus xats.',
  cs: 'Dobrý den. Takto budou znít odpovědi ve vašich chatech.',
  cy: 'Helo. Fel hyn y bydd yr atebion yn swnio yn eich sgyrsiau.',
  da: 'Hej. Sådan vil svarene lyde i dine chats.',
  de: 'Hallo. So werden die Antworten in Ihren Chats klingen.',
  el: 'Γεια σας. Έτσι θα ακούγονται οι απαντήσεις στις συνομιλίες σας.',
  es: 'Hola. Así sonarán las respuestas en tus chats.',
  et: 'Tere. Nii kõlavad vastused teie vestlustes.',
  eu: 'Kaixo. Horrela entzungo dira erantzunak zure txatetan.',
  fa: 'سلام. پاسخ‌ها در گفتگوهای شما این‌گونه شنیده می‌شوند.',
  fi: 'Hei. Näin vastaukset kuulostavat keskusteluissasi.',
  fil: 'Kumusta. Ganito ang tunog ng mga sagot sa iyong mga chat.',
  fr: 'Bonjour. Voici comment les réponses sonneront dans vos conversations.',
  ga: 'Dia dhuit. Seo mar a bheidh na freagraí le cloisteáil i do chomhráite.',
  gl: 'Ola. Así soarán as respostas nas túas conversas.',
  gu: 'નમસ્તે. તમારી ચેટમાં જવાબો આ રીતે સંભળાશે.',
  he: 'שלום. כך יישמעו התשובות בשיחות שלך.',
  hi: 'नमस्ते। आपकी चैट में जवाब इस तरह सुनाई देंगे।',
  hr: 'Pozdrav. Ovako će zvučati odgovori u vašim razgovorima.',
  hu: 'Üdvözlöm. Így fognak hangzani a válaszok a csevegéseiben.',
  hy: 'Բարև ձեզ։ Ձեր զրույցներում պատասխանները այսպես են հնչելու։',
  id: 'Halo. Seperti inilah balasan akan terdengar di obrolan Anda.',
  is: 'Halló. Þannig munu svörin hljóma í spjöllunum þínum.',
  it: 'Ciao. Ecco come suoneranno le risposte nelle tue chat.',
  ja: 'こんにちは。チャットの返信は、このような声で読み上げられます。',
  ka: 'გამარჯობა. თქვენს ჩატებში პასუხები ასე ჩაისმის.',
  kk: 'Сәлеметсіз бе. Чаттарыңыздағы жауаптар осылай естіледі.',
  km: 'សួស្តី។ ចម្លើយក្នុងការជជែករបស់អ្នកនឹងឮបែបនេះ។',
  kn: 'ನಮಸ್ಕಾರ. ನಿಮ್ಮ ಚಾಟ್‌ಗಳಲ್ಲಿ ಉತ್ತರಗಳು ಹೀಗೆ ಕೇಳಿಸುತ್ತವೆ.',
  ko: '안녕하세요. 채팅의 답변은 이런 목소리로 읽어 드립니다.',
  lo: 'ສະບາຍດີ. ຄຳຕອບໃນການສົນທະນາຂອງທ່ານຈະມີສຽງແບບນີ້.',
  lt: 'Sveiki. Taip skambės atsakymai jūsų pokalbiuose.',
  lv: 'Sveiki. Šādi izklausīsies atbildes jūsu sarunās.',
  mk: 'Здраво. Вака ќе звучат одговорите во вашите разговори.',
  ml: 'നമസ്കാരം. നിങ്ങളുടെ ചാറ്റുകളിലെ മറുപടികൾ ഇങ്ങനെയാണ് കേൾക്കുക.',
  mn: 'Сайн байна уу. Таны чат дахь хариултууд ингэж сонсогдох болно.',
  mr: 'नमस्कार. तुमच्या चॅटमधील उत्तरे अशी ऐकू येतील.',
  ms: 'Helo. Begini bunyi balasan dalam sembang anda.',
  mt: 'Bonġu. Hekk se jinstemgħu t-tweġibiet fiċ-chats tiegħek.',
  my: 'မင်္ဂလာပါ။ သင့်ချတ်များတွင် အဖြေများကို ဤသို့ ကြားရပါမည်။',
  nb: 'Hei. Slik vil svarene høres ut i chattene dine.',
  ne: 'नमस्ते। तपाईंको च्याटमा जवाफहरू यसरी सुनिनेछन्।',
  nl: 'Hallo. Zo zullen de antwoorden in je chats klinken.',
  pl: 'Cześć. Tak będą brzmieć odpowiedzi w Twoich czatach.',
  ps: 'سلام. په خبرو اترو کې ځوابونه داسې اورېدل کېږي.',
  pt: 'Olá. É assim que as respostas vão soar nas suas conversas.',
  ro: 'Bună. Așa vor suna răspunsurile în conversațiile tale.',
  ru: 'Здравствуйте. Вот как будут звучать ответы в ваших чатах.',
  si: 'ආයුබෝවන්. ඔබේ කතාබස්වල පිළිතුරු මෙසේ ඇසෙනු ඇත.',
  sk: 'Dobrý deň. Takto budú znieť odpovede vo vašich chatoch.',
  sl: 'Pozdravljeni. Tako bodo zveneli odgovori v vaših pogovorih.',
  so: 'Salaan. Sidan ayay jawaabaha u dhawaaqi doonaan sheekooyinkaaga.',
  sq: 'Përshëndetje. Kështu do të tingëllojnë përgjigjet në bisedat tuaja.',
  sr: 'Здраво. Овако ће звучати одговори у вашим разговорима.',
  sv: 'Hej. Så här kommer svaren att låta i dina chattar.',
  sw: 'Habari. Hivi ndivyo majibu yatakavyosikika kwenye gumzo zako.',
  ta: 'வணக்கம். உங்கள் உரையாடல்களில் பதில்கள் இப்படித்தான் ஒலிக்கும்.',
  te: 'నమస్కారం. మీ చాట్‌లలో సమాధానాలు ఇలా వినిపిస్తాయి.',
  th: 'สวัสดี นี่คือเสียงของคำตอบในแชทของคุณ',
  tr: 'Merhaba. Sohbetlerinizdeki yanıtlar böyle duyulacak.',
  uk: 'Вітаю. Ось як звучатимуть відповіді у ваших чатах.',
  ur: 'السلام علیکم۔ آپ کی چیٹ میں جوابات ایسے سنائی دیں گے۔',
  uz: 'Salom. Suhbatlaringizdagi javoblar shunday eshitiladi.',
  vi: 'Xin chào. Đây là cách các câu trả lời sẽ được đọc trong cuộc trò chuyện của bạn.',
  zh: '你好——这就是聊天中回复朗读时的声音。',
  'zh-TW': '你好——這就是聊天中回覆朗讀時的聲音。',
  'zh-HK': '你好——這就是聊天中回覆朗讀時的聲音。',
  'zh-MO': '你好——這就是聊天中回覆朗讀時的聲音。',
  zu: 'Sawubona. Izimpendulo zizozwakala kanje ezingxoxweni zakho.',
};

/** The sample sentence for a BCP-47 tag: the full tag's, else its language's, else English. */
export function samplePhrase(locale: string): string {
  const [language = '', region = ''] = locale.split(/[-_]/);
  const exact = PHRASES[`${language.toLowerCase()}-${region.toUpperCase()}`];
  return exact ?? PHRASES[language.toLowerCase()] ?? ENGLISH;
}
