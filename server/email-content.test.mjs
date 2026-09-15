import test from 'node:test'
import assert from 'node:assert/strict'
import nodemailer from 'nodemailer'
import { emailHtml } from './email-content.mjs'

test('recharge links are explicit anchors and escape query strings and channel text', () => {
  const html = emailHtml('预警 <fixture>', '渠道名称：<img src=x onerror=alert(1)>\n渠道 URL：https://fixture.example\n快速充值：https://fixture.example/topup?plan=1&from=mail')
  assert.match(html, /href="https:\/\/fixture.example\/topup\?plan=1&amp;from=mail"/)
  assert.match(html, /点击前往渠道充值/)
  assert(!html.includes('<img'))
  assert(html.includes('&lt;fixture&gt;'))
  for (const url of ['javascript:alert(1)', 'https://user:secret@fixture.example', 'data:text/html,test']) {
    assert(!emailHtml('test', '快速充值：' + url).includes('<a '))
  }
})

test('mail MIME includes both readable plain text and HTML recharge link without sending', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  const body = '渠道名称：Fixture\n当前余额：5 credits\n快速充值：https://fixture.example/topup'
  const result = await transport.sendMail({ from: 'fixture@example.com', to: 'fixture@example.com', subject: 'Balance alert', text: body, html: emailHtml('Balance alert', body) })
  const message = result.message.toString()
  assert.match(message, /multipart\/alternative/)
  assert.match(message, /Content-Type: text\/plain/)
  assert.match(message, /Content-Type: text\/html/)
  assert.match(message.replace(/=\r?\n/g, '').replace(/=3D/g, '='), /href="https:\/\/fixture.example\/topup"/)
})
