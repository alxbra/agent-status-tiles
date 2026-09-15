/** Prevent a late initial request from replacing a newer pushed Settings state. */
export class SettingsLoadSequence {
  private receivedPublication = false;

  markPublicationReceived(): void {
    this.receivedPublication = true;
  }

  shouldAcceptInitialResult(): boolean {
    return !this.receivedPublication;
  }
}
