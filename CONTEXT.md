# Hybrid White Elephant

A web app for running a white elephant gift exchange across a team that is never all in the office on the same day. The game can play out over several days, each player acting when it is their turn. The physical gifts stay in one office; the app is the source of truth for who holds what.

## Language

**Host**:
The supervisor-level person who creates and runs a game. Has an account (email and password). May also play.
_Avoid_: Admin, organizer, owner

**Helper**:
A member the host appoints to do the physical work: photograph gifts, open picked gifts, confirm them, and undo recent mistakes. May be a non-playing member. Nobody confirms their own turn.
_Avoid_: Moderator, assistant

**Player**:
A person who takes turns in the game. Has no account: their identity is their seat (a membership) in one game, reached through a personal link.
_Avoid_: User, participant, member (when the person is taking turns)

**Gift**:
One physical wrapped present, registered with a photo, an automatic label such as "Gift 7", and a hidden note of which player brought it. A gift is either unopened or opened.
_Avoid_: Present, item, prize

**Pending pick**:
A player's choice of an unopened gift, held until a helper or the host opens it, photographs it and confirms. The player's turn clock does not run while a pick is pending, because the next player may want to steal that exact gift.
_Avoid_: Reservation, claim

**Steal**:
Taking an opened, unlocked gift from the player who holds it. It completes immediately, and the player stolen from acts next, after which the order resumes.
_Avoid_: Swap, trade, take

**Lock**:
The state a gift reaches when it has been stolen as many times as the steal limit allows; a locked gift can no longer be stolen or swapped.
_Avoid_: Freeze, protect

**Final swap**:
An optional last exchange offered to the first x% of players by original draw position, acting in reverse draw order, trading one-for-one with the holder of an unlocked gift. It does not affect steal counts or locks.
_Avoid_: Last round, redo

**Draw position**:
A player's place in the original seeded random shuffle that sets the turn order. It is permanent, even if a player is later pushed to the end of the order, and it decides final-swap eligibility.
_Avoid_: Turn number, rank, seed (the seed is the shuffle's input, not a position)

## Relationships

- A **Host** creates a game and appoints zero or more **Helpers**; every **Player** has exactly one seat in exactly one game.
- A **Gift** is brought by one **Player**, and that tag stays hidden from players until the reveal at the end.
- A **Pending pick** turns into a held **Gift** when a **Helper** or the **Host** confirms it; the person confirming is never the player whose turn it is.
- A **Steal** increases a **Gift**'s steal count; reaching the limit applies a **Lock**.
- **Final swap** eligibility is computed from **Draw positions**, not from the current turn order.

## Flagged ambiguities

- "Seed" means the input to the draw's shuffle, shown for transparency; it is not a **Draw position**.
- A "pushed" player moves to the end of the *turn order* but keeps their original **Draw position**.
