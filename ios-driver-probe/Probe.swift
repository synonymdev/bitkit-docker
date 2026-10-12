import SwiftUI

@main
struct DriverProbe: App {
    var body: some Scene {
        WindowGroup { ProbeView() }
    }
}

struct ProbeView: View {
    @State private var taps = 0

    var body: some View {
        VStack(spacing: 24) {
            Text("Driver ready").accessibilityIdentifier("ProbeReady")
            Text("Touches: \(taps)").accessibilityIdentifier("ProbeCount")
            Button("Touch once") { taps += 1 }
                .accessibilityIdentifier("ProbeTap")
        }
        .padding()
        .preferredColorScheme(.dark)
    }
}
