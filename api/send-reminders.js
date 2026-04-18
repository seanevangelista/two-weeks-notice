import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
const resend = new Resend(process.env.RESEND_API_KEY)

export default async function handler(req, res) {
  // Security check — Vercel cron sends this automatically
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // Find events exactly 14 days from today
  const target = new Date()
  target.setDate(target.getDate() + 14)
  const targetMonth = target.getMonth() + 1
  const targetDay = target.getDate()

  const { data: events, error } = await supabase
    .from('events')
    .select('*, people(*)')
    .eq('month', targetMonth)
    .eq('day', targetDay)

  if (error) return res.status(500).json({ error: error.message })
  if (!events?.length) return res.status(200).json({ sent: 0, message: 'No events today' })

  let sent = 0
  const errors = []

  for (const event of events) {
    const person = event.people
    if (!person) continue

    // Look up the user's email preference
    const { data: prefs } = await supabase
      .from('notification_prefs')
      .select('email')
      .eq('user_id', person.user_id)
      .maybeSingle()

    if (!prefs?.email) continue

    const amazonQuery = encodeURIComponent(
      `${event.label} gift ${person.relationship || ''} ${person.interests || ''}`.trim()
    )
    const amazonUrl = `https://www.amazon.com/s?k=${amazonQuery}`
    const budget = `$${person.budget_min}–$${person.budget_max}`
    const interestsHtml = person.interests
      ? `<p style="color:#555;font-size:14px;margin:8px 0;">They love: <strong>${person.interests}</strong></p>`
      : ''
    const notesHtml = person.notes
      ? `<p style="color:#888;font-size:13px;margin:8px 0;">Note: ${person.notes}</p>`
      : ''

    try {
      await resend.emails.send({
        from: 'Two Weeks Notice <reminders@recalldate.com>',
        to: prefs.email,
        subject: `🎁 ${person.name}'s ${event.label} is in 14 days`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f7f5f0;">
            <div style="background:#fff;border-radius:14px;padding:24px;">
              <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 4px;">Two Weeks Notice 🎁</h1>
              <p style="color:#888;font-size:13px;margin:0 0 20px;">Never miss an important moment</p>
              <hr style="border:none;border-top:1px solid #e8e4dc;margin:16px 0;" />
              <h2 style="font-size:18px;margin:8px 0;">${person.name}'s ${event.label} is in 14 days</h2>
              <p style="font-size:14px;color:#444;margin:8px 0;">Budget: <strong>${budget}</strong></p>
              ${interestsHtml}
              ${notesHtml}
              <a href="${amazonUrl}" style="display:inline-block;margin-top:16px;padding:12px 20px;background:#FF9900;color:#111;font-weight:700;font-size:14px;text-decoration:none;border-radius:8px;">
                🛍 Find a gift on Amazon
              </a>
              <p style="font-size:11px;color:#aaa;margin-top:28px;">You're getting this because you signed up for Two Weeks Notice reminders at twoweeknotice.vercel.app</p>
            </div>
          </div>
        `
      })
      sent++
    } catch (err) {
      errors.push({ person: person.name, error: err.message })
    }
  }

  return res.status(200).json({ sent, total: events.length, errors })
}
