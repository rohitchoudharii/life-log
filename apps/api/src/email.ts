export type EmailSender = { send(to: string, subject: string, text: string): Promise<void> }

/** Development sender: prints the email to the API log. Swap in Resend or Postmark when hosting is decided. */
export const consoleEmail: EmailSender = {
	async send(to, subject, text) {
		console.log(`\n[email] to ${to}\n  ${subject}\n  ${text}\n`)
	},
}

export const email: EmailSender = consoleEmail
