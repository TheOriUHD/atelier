package proxy

import "fmt"

// Tailscale Serve terminates HTTPS with a certificate it gets for the machine's *.ts.net name and forwards to a local
// address over plain HTTP. It passes WebSockets. The URL has to be that exact name, and the port 443 unless named.
func tailscale(s spec) Snippet {
	command := fmt.Sprintf("tailscale serve --bg --https=%d http://%s", s.port, s.upstream)
	snippet := Snippet{
		Title: "Tailscale Serve command",
		Body:  command + "\n",
		Steps: []string{
			"In the Tailscale admin console, open the DNS page and make sure MagicDNS is on and HTTPS Certificates is enabled for your tailnet. Without it Tailscale cannot get a certificate for the machine's name.",
			"On the machine that runs Tailscale and can reach the upstream, run the command. On Linux add `sudo`, unless you made yourself the operator with `sudo tailscale set --operator=$USER`. `--bg` keeps it serving in the background, also after a restart.",
			fmt.Sprintf("Run `tailscale serve status`. It prints the address Tailscale serves, which must be exactly `%s`.", s.origin),
			"To find the machine's full *.ts.net name, take its name from `tailscale status` and add your tailnet's name from the DNS page of the admin console. `tailscale cert <name>` is not needed for this: Serve gets and renews its certificate itself.",
			"To stop serving, run `tailscale serve reset`.",
		},
	}
	snippet.Notes = []string{
		"The usual mistake: HTTPS Certificates is not enabled for the tailnet, or ATELIER_BASE_URL is not the machine's exact *.ts.net name. Tailscale then cannot serve HTTPS, or Atelier refuses the browser's address and the page spins.",
		"Only devices signed in to your tailnet can reach the address, including the desktop apps. Tailscale Funnel would make it public. That is a separate opt-in, and it is not recommended for Atelier.",
		"This uses `tailscale serve` as in Tailscale 1.52 and newer. Older versions had a different syntax.",
		"Tailscale passes WebSockets without any setting.",
	}
	snippet.Notes = append(snippet.Notes, sharedNotes(s, "Tailscale")...)
	return snippet
}
