import EventKit
import Foundation

enum ReaderError: LocalizedError {
    case usage
    case calendarAccessRequired
    case invalidDate(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: eink-calendar-reader authorize | list-calendars | events <start-iso8601> <end-iso8601>"
        case .calendarAccessRequired:
            return "Calendar full access is required. Run: eink-calendar-reader authorize"
        case .invalidDate(let value):
            return "Invalid ISO-8601 date: \(value)"
        }
    }
}

private let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private let fallbackIsoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

private func parseDate(_ value: String) throws -> Date {
    guard let date = isoFormatter.date(from: value) ?? fallbackIsoFormatter.date(from: value) else {
        throw ReaderError.invalidDate(value)
    }
    return date
}

private func jsonData(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

private func writeJson(_ value: Any) throws {
    FileHandle.standardOutput.write(try jsonData(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

private func responseStatus(_ event: EKEvent) -> String {
    if event.organizer?.isCurrentUser == true { return "accepted" }
    if (event.attendees?.isEmpty ?? true) && event.calendar.allowsContentModifications {
        return "accepted"
    }
    guard let status = event.attendees?.first(where: { $0.isCurrentUser })?.participantStatus else {
        return "unknown"
    }
    switch status {
    case .accepted, .completed, .inProcess:
        return "accepted"
    case .declined:
        return "declined"
    case .tentative:
        return "tentative"
    case .pending:
        return "needsAction"
    default:
        return "unknown"
    }
}

private func requireAccess() throws {
    guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
        throw ReaderError.calendarAccessRequired
    }
}

@main
struct EinkCalendarReader {
    static func main() async {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard let command = arguments.first else { throw ReaderError.usage }
            let store = EKEventStore()

            switch command {
            case "authorize":
                if EKEventStore.authorizationStatus(for: .event) != .fullAccess {
                    let granted = try await store.requestFullAccessToEvents()
                    guard granted else { throw ReaderError.calendarAccessRequired }
                }
                try writeJson(["authorized": true])

            case "list-calendars":
                try requireAccess()
                let calendars = store.calendars(for: .event)
                    .sorted { left, right in
                        if left.source.title == right.source.title { return left.title < right.title }
                        return left.source.title < right.source.title
                    }
                    .map { calendar in
                        [
                            "calendarIdentifier": calendar.calendarIdentifier,
                            "calendarName": calendar.title,
                            "sourceIdentifier": calendar.source.sourceIdentifier,
                            "sourceName": calendar.source.title,
                        ]
                    }
                try writeJson(calendars)

            case "events":
                guard arguments.count == 3 else { throw ReaderError.usage }
                try requireAccess()
                let start = try parseDate(arguments[1])
                let end = try parseDate(arguments[2])
                let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
                let events = store.events(matching: predicate)
                    .filter { $0.status != .canceled }
                    .sorted { $0.startDate < $1.startDate }
                    .map { event -> [String: Any] in
                        var output: [String: Any] = [
                            "eventIdentifier": event.eventIdentifier ?? event.calendarItemIdentifier,
                            "calendarName": event.calendar.title,
                            "sourceName": event.calendar.source.title,
                            "title": event.title ?? "Untitled event",
                            "start": isoFormatter.string(from: event.startDate),
                            "end": isoFormatter.string(from: event.endDate),
                            "allDay": event.isAllDay,
                            "recurring": !(event.recurrenceRules?.isEmpty ?? true),
                            "organizer": event.organizer?.isCurrentUser ?? false,
                            "attendeeCount": event.attendees?.count ?? 0,
                            "responseStatus": responseStatus(event),
                            "transparency": event.availability == .free ? "transparent" : "opaque",
                        ]
                        if let location = event.location, !location.isEmpty { output["location"] = location }
                        if let notes = event.notes, !notes.isEmpty { output["notes"] = notes }
                        return output
                    }
                try writeJson(events)

            default:
                throw ReaderError.usage
            }
        } catch {
            FileHandle.standardError.write(Data("Error: \(error.localizedDescription)\n".utf8))
            Foundation.exit(1)
        }
    }
}
