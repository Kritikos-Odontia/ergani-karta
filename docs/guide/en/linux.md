# Install on Linux

You need 64-bit Linux. For Ubuntu 22.04+, Debian 12+ and Mint, choose `…-linux-x64.deb` from [download](download.md).

- Double-click → Install, or from the download folder:

```sh
sudo apt install ./karta-ergasias-<version>-linux-x64.deb
```

- For other distributions, extract `…-linux-x64.tar.gz` and run `sh install.sh` inside it **as your own user**, without sudo.

Open **Κάρτα Εργασίας** from applications. Setup opens in your browser (`http://127.0.0.1:8881`). Continue with [users, PINs and devices](access.md). The program starts at user sign-in through a systemd user service; keep the computer running.

If you use a firewall, allow port 8880 only from the practice's private network. Do not expose it to the internet. For a computer without a desktop or remote branches, use the [technical Docker guide](docker.md).

To uninstall the application: `sudo apt remove karta-ergasias`, or `sh uninstall.sh` for the tar.gz installation. The employer's record remains; do not delete it with the application.
