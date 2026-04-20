import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const resend = new Resend(process.env.RESEND_API_KEY)

export default async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const today = new Date()
  const in14 = new Date()
  in14.setDate(today.getDate() + 14)

  const fmt = d => {
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${m}-${day}`
  }
  const todayStr = fmt(today)
  const in14Str  = fmt(in14)

  const { data: people, error } = await supabase.from('people').select('*')
  if (error) return res.status(500).json({ error: error.message })

  let totalSent = 0
  const errors = []

  for (const person of people) {
    const dates = person.dates || []

    for (const d of dates) {
      if (!d.date) continue

      const isToday  = d.date === todayStr
      const is14Away = d.date === in14Str
      if (!isToday && !is14Away) continue

      const reminderType = isToday ? 'today' : '14days'

      // Skip if already sent today
      const { data: alreadySent } = await supabase
        .from('reminders_sent')
        .select('id')
        .eq('person_id', person.id)
        .eq('event_date', d.date)
        .eq('reminder_type', reminderType)
        .eq('sent_on', today.toISOString().slice(0, 10))
        .maybeSingle()

      if (alreadySent) continue

      // Get the user's email from Supabase auth
      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(person.user_id)
      if (userError || !userData?.user?.email) continue
      const toEmail = userData.user.email

      // Build Amazon gift link
      const interests = (person.interests || []).join(' ')
      const amazonQuery = encodeURIComponent(`${interests} gift`.trim() || 'gift ideas')
      const budgetParam = buildBudgetParam(person.budget)
      const amazonUrl = `https://www.amazon.com/s?k=${amazonQuery}&tag=recalldate-20${budgetParam}`

      const eventLabel = d.type || 'Important date'
      const subject = isToday
        ? `🎉 It's ${person.name}'s ${eventLabel} today!`
        : `🎁 ${person.name}'s ${eventLabel} is in 14 days`
      const heading = isToday
        ? `Today is ${person.name}'s ${eventLabel}!`
        : `${person.name}'s ${eventLabel} is in 14 days`
      const intro = isToday
        ? `Don't let the day slip by. A quick text, call, or last-minute gift goes a long way.`
        : `You've got 14 days — enough time to order the perfect gift from Amazon.${person.budget ? ` Budget: <strong>${person.budget}</strong>` : ''}`
      const interestsHtml = interests
        ? `<p style="color:#555;font-size:14px;margin:8px 0;">They love: <strong>${interests}</strong></p>`
        : ''
      const notesHtml = person.notes
        ? `<p style="color:#888;font-size:13px;margin:8px 0;">Note: ${person.notes}</p>`
        : ''
      const buttonText = isToday ? '🎁 Last-minute gift ideas' : '🎁 Find a gift on Amazon'

      try {
        await resend.emails.send({
          from: 'RecallDate <reminders@recalldate.com>',
          to: toEmail,
          subject,
          html: `
            <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f7f5f0;">
              <div style="background:#fff;border-radius:14px;padding:24px;">
                <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 4px;">RecallDate 🎁</h1>
                <p style="color:#888;font-size:13px;margin:0 0 20px;">Never miss an important moment</p>
                <hr style="border:none;border-top:1px solid #e8e4dc;margin:16px 0;" />
                <h2 style="font-size:18px;margin:8px 0;">${heading}</h2>
                <p style="font-size:14px;color:#444;margin:8px 0;">${intro}</p>
                ${interestsHtml}
                ${notesHtml}
                <a href="${amazonUrl}" style="display:inline-block;margin-top:16px;padding:12px 20px;background:#FF9900;color:#111;font-weight:700;font-size:14px;text-decoration:none;border-radius:8px;">
                  ${buttonText}
                </a>
                <hr style="border:none;border-top:1px solid #e8e4dc;margin:24px 0 12px;" />
                <p style="font-size:11px;color:#aaa;margin:0;">You're getting this because you use RecallDate at recalldate.com. To stop receiving reminders, sign in and remove this person's date.</p>
              </div>
            </div>
          `
        })

        // Log the sent reminder to prevent duplicates
        await supabase.from('reminders_sent').insert({
          person_id: person.id,
          event_date: d.date,
          reminder_type: reminderType,
          sent_on: today.toISOString().slice(0, 10)
        })

        totalSent++
      } catch (err) {
        errors.push({ person: person.name, event: eventLabel, error: err.message })
      }
    }
  }

  return res.status(200).json({ sent: totalSent, errors })
}

function buildBudgetParam(budget) {
  const map = {
    'under $25':   '&high-price=25',
    '$25-$50':     '&low-price=25&high-price=50',
    '$50-$100':    '&low-price=50&high-price=100',
    '$100-$200':   '&low-price=100&high-price=200',
    '$200+':       '&low-price=200',
    'surprise me': ''
  }
  return map[budget] || ''
}
