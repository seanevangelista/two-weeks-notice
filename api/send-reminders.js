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
  const in14Days = new Date()
  in14Days.setDate(today.getDate() + 14)

  const targets = [
    { month: today.getMonth() + 1, day: today.getDate(), type: 'today' },
    { month: in14Days.getMonth() + 1, day: in14Days.getDate(), type: 'twoWeeks' }
  ]

  let totalSent = 0
  const errors = []

  for (const t of targets) {
    const { data: events } = await supabase
      .from('events')
      .select('*, people(*)')
      .eq('month', t.month)
      .eq('day', t.day)

    if (!events?.length) continue

    for (const event of events) {
      const person = event.people
      if (!person) continue

      const { data: prefs } = await supabase
        .from('notification_prefs')
        .select('email')
        .eq('user_id', person.user_id)
        .maybeSingle()

      if (!prefs?.email) continue

      const amazonQuery = encodeURIComponent(
        `${event.label} gift ${person.relationship || ''} ${person.interests || ''}`.trim()
      )
      const amazonUrl = `https://www.amazon.com/s?k=${amazonQuery}&tag=recalldate-20`
      const budget = `$${person.budget_min}-$${person.budget_max}`
      const interestsHtml = person.interests
        ? `<p style="color:#555;font-size:14px;margin:8px 0;">They love: <strong>${person.interests}</strong></p>`
        : ''
      const notesHtml = person.notes
        ? `<p style="color:#888;font-size:13px;margin:8px 0;">Note: ${person.notes}</p>`
        : ''

      const isToday = t.type === 'today'
      const subject = isToday
        ? `🎉 It's ${person.name}'s ${event.label} today!`
        : `🎁 ${person.name}'s ${event.label} is in 14 days`

      const heading = isToday
        ? `Today is ${person.name}'s ${event.label}!`
        : `${person.name}'s ${event.label} is in 14 days`

      const intro = isToday
        ? `Don't let the day slip by. A quick text, call, or last-minute gift goes a long way.`
        : `Time to plan the perfect gift. Budget: <strong>${budget}</strong>`

      const buttonText = isToday ? '🎁 Last-minute gift ideas' : '🎁 Find a gift on Amazon'

      try {
        await resend.emails.send({
          from: 'RecallDate <reminders@recalldate.com>',
          to: prefs.email,
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
                <p style="font-size:11px;color:#aaa;margin-top:28px;">You're getting this because you signed up for RecallDate reminders at recalldate.com</p>
              </div>
            </div>
          `
        })
        totalSent++
      } catch (err) {
        errors.push({ person: person.name, type: t.type, error: err.message })
      }
    }
  }

  return res.status(200).json({ sent: totalSent, errors })
}
