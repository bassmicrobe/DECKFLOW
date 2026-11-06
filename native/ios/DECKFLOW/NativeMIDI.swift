import CoreMIDI
import Foundation

/// MIDI 1 input adapter. No client/port is created until enable() is called
/// by the Web UI's explicit “MIDIを接続” action.
final class NativeMIDI {
    struct Input {
        let endpoint: MIDIEndpointRef
        let id: String
        let name: String
        let manufacturer: String
        var dictionary: [String: Any] {
            ["id": id, "name": name, "manufacturer": manufacturer, "state": "connected"]
        }
    }
    private var client: MIDIClientRef = 0
    private var port: MIDIPortRef = 0
    private var inputs: [MIDIEndpointRef: Input] = [:]
    private var framers: [MIDIEndpointRef: MIDIMessageFramer] = [:]
    var onPorts: (([[String: Any]]) -> Void)?
    var onMessages: ((String, [[UInt8]]) -> Void)?
    private(set) var enabled = false

    func enable() throws -> [[String: Any]] {
        dispatchPrecondition(condition: .onQueue(.main))
        if !enabled {
            let clientStatus = MIDIClientCreateWithBlock("DECKFLOW" as CFString, &client) { [weak self] _ in
                DispatchQueue.main.async { self?.refresh() }
            }
            guard clientStatus == noErr else { throw MIDIError(status: clientStatus) }
            let inputStatus = MIDIInputPortCreateWithBlock(client, "DECKFLOW Input" as CFString, &port) { [weak self] packetList, context in
                guard let context else { return }
                let endpoint = MIDIEndpointRef(UInt(bitPattern: context))
                var bytes: [UInt8] = []
                let packetOffset = MemoryLayout<MIDIPacketList>.offset(of: \.packet)!
                let dataOffset = MemoryLayout<MIDIPacket>.offset(of: \.data)!
                var packet = UnsafeRawPointer(packetList).advanced(by: packetOffset).assumingMemoryBound(to: MIDIPacket.self)
                for _ in 0..<packetList.pointee.numPackets {
                    let data = UnsafeRawPointer(packet).advanced(by: dataOffset).assumingMemoryBound(to: UInt8.self)
                    bytes.append(contentsOf: UnsafeBufferPointer(start: data, count: Int(packet.pointee.length)))
                    packet = UnsafePointer(MIDIPacketNext(packet))
                }
                let copied = bytes
                DispatchQueue.main.async { self?.receive(endpoint: endpoint, bytes: copied) }
            }
            guard inputStatus == noErr else {
                MIDIClientDispose(client); client = 0
                throw MIDIError(status: inputStatus)
            }
            enabled = true
        }
        refresh()
        return snapshot()
    }

    private func snapshot() -> [[String: Any]] {
        inputs.values.sorted { $0.id < $1.id }.map(\.dictionary)
    }

    private func refresh() {
        guard enabled else { return }
        var found: [MIDIEndpointRef: Input] = [:]
        for index in 0..<MIDIGetNumberOfSources() {
            let endpoint = MIDIGetSource(index)
            guard endpoint != 0 else { continue }
            var unique: MIDIUniqueID = 0
            MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &unique)
            let id = unique == 0 ? "endpoint-\(endpoint)" : "coremidi-\(unique)"
            let input = Input(endpoint: endpoint, id: id,
                              name: Self.property(endpoint, kMIDIPropertyDisplayName) ?? Self.property(endpoint, kMIDIPropertyName) ?? "MIDI入力",
                              manufacturer: Self.property(endpoint, kMIDIPropertyManufacturer) ?? "")
            if inputs[endpoint] == nil {
                let status = MIDIPortConnectSource(port, endpoint, UnsafeMutableRawPointer(bitPattern: UInt(endpoint)))
                guard status == noErr else { continue }
            }
            found[endpoint] = input
        }
        for endpoint in inputs.keys where found[endpoint] == nil {
            MIDIPortDisconnectSource(port, endpoint)
            framers.removeValue(forKey: endpoint)
        }
        inputs = found
        onPorts?(snapshot())
    }

    private static func property(_ endpoint: MIDIEndpointRef, _ key: CFString) -> String? {
        var value: Unmanaged<CFString>?
        guard MIDIObjectGetStringProperty(endpoint, key, &value) == noErr else { return nil }
        return value?.takeRetainedValue() as String?
    }

    private func receive(endpoint: MIDIEndpointRef, bytes: [UInt8]) {
        guard enabled, let input = inputs[endpoint] else { return }
        var framer = framers[endpoint] ?? MIDIMessageFramer()
        let messages = framer.append(bytes)
        framers[endpoint] = framer
        if !messages.isEmpty { onMessages?(input.id, messages) }
    }

    func stop() {
        for endpoint in inputs.keys { MIDIPortDisconnectSource(port, endpoint) }
        if port != 0 { MIDIPortDispose(port) }
        if client != 0 { MIDIClientDispose(client) }
        port = 0; client = 0; enabled = false
        inputs.removeAll(); framers.removeAll()
    }

    deinit { stop() }

    struct MIDIError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "MIDI入力を開始できませんでした（\(status)）。接続を確認してください。" }
    }
}

/// Handles concatenated packets and running status. SysEx/system messages are
/// deliberately not exposed; the Web mapping engine uses channel messages.
struct MIDIMessageFramer {
    private var status: UInt8?
    private var data: [UInt8] = []
    private var inSysEx = false

    mutating func append(_ bytes: [UInt8]) -> [[UInt8]] {
        var messages: [[UInt8]] = []
        for byte in bytes {
            if byte >= 0xF8 { continue } // realtime messages don't clear running status
            if byte == 0xF0 { inSysEx = true; status = nil; data.removeAll(); continue }
            if byte == 0xF7 { inSysEx = false; status = nil; data.removeAll(); continue }
            if inSysEx { continue }
            if byte >= 0xF0 { status = nil; data.removeAll(); continue }
            if byte >= 0x80 { status = byte; data.removeAll(); continue }
            guard let status else { continue }
            data.append(byte)
            let needed = (status >> 4 == 0xC || status >> 4 == 0xD) ? 1 : 2
            if data.count == needed {
                messages.append([status] + data)
                data.removeAll(keepingCapacity: true)
            }
        }
        return messages
    }
}
