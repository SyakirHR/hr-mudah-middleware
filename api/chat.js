export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, history } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  const systemPrompt = `You are an HR assistant for Malaysian companies... (KEEP YOUR EXISTING PROMPT EXACTLY SAME)`;


  // ─── Parse conversation history ───────────────────────────────────────────
  let parsedHistory = [];
  if (history && Array.isArray(history)) {
    parsedHistory = history;
  } else if (history && typeof history === 'string' && history.trim().length > 0) {
    const pairs = history.split('[PAIR]');
    pairs.forEach(pair => {
      const sepIndex = pair.indexOf('[SEP]');
      if (sepIndex > -1) {
        const q = pair.substring(0, sepIndex).trim();
        const a = pair.substring(sepIndex + 5).trim();
        if (q && a) parsedHistory.push({ question: q, answer: a });
      }
    });
  }

  // ─── Build messages ──────────────────────────────────────────────────────
  const messages = [{ role: 'system', content: systemPrompt }];

  parsedHistory.forEach(exchange => {
    if (exchange.question) messages.push({ role: 'user', content: exchange.question });
    if (exchange.answer)   messages.push({ role: 'assistant', content: exchange.answer });
  });

  // ─── FIXED SECTION (VERY IMPORTANT) ──────────────────────────────────────

  const questionLower = question.trim().toLowerCase();
  const hasHistory = parsedHistory.length > 0;

  // ✅ STRIP HTML HERE
  const lastBotAnswer = hasHistory
    ? (parsedHistory[parsedHistory.length - 1]?.answer ?? '')
        .replace(/<[^>]*>/g, '')   // <<< THIS FIX
        .toLowerCase()
    : '';

  const botJustAskedClarification =
    lastBotAnswer.includes('rest day') &&
    lastBotAnswer.includes('off day') &&
    (lastBotAnswer.includes('sahkan') || lastBotAnswer.includes('confirm') ||
     lastBotAnswer.includes('maksudkan') || lastBotAnswer.includes('clarif'));

  const mentionsOffDay = ['off day', 'offday', 'hari tidak bekerja', 'hari cuti'].some(k => questionLower.includes(k));
  const mentionsRestDay = ['rest day', 'restday', 'hari rehat'].some(k => questionLower.includes(k));

  if (botJustAskedClarification) {
    const dayType = mentionsRestDay ? 'REST DAY (Section 60 rates apply)'
                  : mentionsOffDay  ? 'OFF DAY (1.5x hourly rate per hour worked)'
                  : 'the day type the user just confirmed';

    messages.push({
      role: 'system',
      content: `The user is answering your previous clarification question. They confirmed: "${question}". Treat this as ${dayType}. Answer the ORIGINAL question accordingly. Do NOT explain definitions. Do NOT ask again.`
    });

  } else if (mentionsOffDay && !hasHistory) {
    messages.push({
      role: 'system',
      content: 'Perkataan "off day" tidak jelas. Tanya: Hari Rehat atau Off Day polisi. Tambah [CHOICES: Hari Rehat (Seksyen 59) | Off Day (Polisi Syarikat)].'
    });
  }

  messages.push({ role: 'user', content: question });

  // ─── Call OpenAI ─────────────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages,
        max_tokens: 1000,
        temperature: 0.1
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'OpenAI error' });
    }

    const rawAnswer = data.choices[0].message.content;

    // ─── Convert to HTML ────────────────────────────────────────────────────
    let htmlAnswer = rawAnswer.replace(/\n/g, '<br>');

    const answer = `<div style="font-family:Poppins;font-size:12px;">${htmlAnswer}</div>`;

    // ─── Extract choices ────────────────────────────────────────────────────
    const choicesMatch = answer.match(/\[CHOICES:\s*([^\]]+)\]/);
    let choicesString = '';
    let cleanAnswer = answer;

    if (choicesMatch) {
      const choicesArray = choicesMatch[1].split('|').map(s => s.trim());
      choicesString = choicesArray.join(' | ');
      cleanAnswer = answer.replace(/\[CHOICES:[^\]]+\]/, '');
    }

    return res.status(200).json({
      answer: cleanAnswer,
      choices: choicesString
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
