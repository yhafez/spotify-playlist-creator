import fs from 'fs';
import { artists, results, playlistIds, lastUpdated, lastLikedTracks, lastPlaylistTracks } from './data'
import spotifyApi from './auth';

export type FilteredTrack = {
    name: string,
    artist: string,
    uri: string
}

export type Results = {
    [key: string]: {
        skipped: boolean,
        addedSongs: number,
        skippedSongs: number,
        lastUpdated: number
    }
}

export const waitForAccessToken = async () => {
    if (!spotifyApi.getAccessToken()) setTimeout(await waitForAccessToken, 100);
    else return Promise.resolve(true);
}

export const writeToDataFile = (lastUpdated: number, lastLikedTracks: FilteredTrack[], playlistIds: string[], playlistTracks: { [key: string]: FilteredTrack[] }, artists: string[], results: Results) => {
    fs.writeFileSync('data.ts', `import type { FilteredTrack, Results } from './utils'

export const lastUpdated = ${lastUpdated}

export const artists = ${JSON.stringify(artists, null, 4)}

export const lastLikedTracks: FilteredTrack[] = ${JSON.stringify(lastLikedTracks, null, 4)}

export const playlistIds = ${JSON.stringify(playlistIds, null, 4)}

export const lastPlaylistTracks: { [key: string]: FilteredTrack[] } = ${JSON.stringify(playlistTracks, null, 4)}

export const results: Results = ${JSON.stringify(results, null, 4)}`);
}


export const removeDuplicateArtists = (artistsArr: string[], playlistTracks: { [key: string]: FilteredTrack[] }) => {
    const seen = new Set();
    const cleanArtists = artistsArr.map((item) => {
        return item.toLocaleLowerCase();
    }).filter((item) => {
        return seen.has(item) ? false : seen.add(item);
    })

    // Write result to the file system
    writeToDataFile(lastUpdated, lastLikedTracks, playlistIds, playlistTracks, cleanArtists, results);
    return cleanArtists;
}

export const getLikedTracks = async (): Promise<FilteredTrack[]> => {
    const likedTrackResults: FilteredTrack[] = [];

    // Batch size
    const batchSize = 10;

    // Total number of batches
    const totalBatches = Math.ceil(15000 / (batchSize * 50));

    for (let i = 0; i < totalBatches; i++) {
        console.log('Getting liked tracks', i * batchSize * 50, 'to', (i * batchSize * 50) + batchSize * 50);
        try {
            const promises = [];
            for (let j = 0; j < batchSize; j++) {
                const offset = (i * batchSize + j) * 50;
                promises.push(spotifyApi.getMySavedTracks({ limit: 50, offset }));
            }
            const responses = await Promise.all(promises);

            let batchFilteredTracks: FilteredTrack[] = [];
            responses.forEach((response) => {
                const filteredTracks = response.body.items
                    .filter((item) => item && item.track)
                    .map((item) => {
                        return {
                            name: item.track!.name,
                            artist: item.track!.artists[0].name,
                            uri: item.track!.uri
                        };
                    });
                batchFilteredTracks.push(...filteredTracks);
            });

            if (batchFilteredTracks.length === 0) {
                console.log('No more liked tracks');
                break;
            }
            likedTrackResults.push(...batchFilteredTracks);
        } catch (error) {
            console.log('Rate limit hit. Waiting 1 second and trying again.');
            await new Promise((resolve) => setTimeout(resolve, 1000));
            i--;
            continue;
        }
    }

    console.log('Liked tracks: ', likedTrackResults.length);
    writeToDataFile(Date.now(), likedTrackResults, playlistIds, lastPlaylistTracks, artists, results);
    return likedTrackResults;
};


export const getPlaylistTracks = async (useInitialOffset = false) => {
    const playlistTracksResults: { [key: string]: FilteredTrack[] } = lastPlaylistTracks;

    let failCount = 0;
    for (let j = 0; j < playlistIds.length; j++) {
        // If playlist is full, use the next playlist, or create a new one if there are no more
        if (playlistTracksResults[playlistIds[j]].length >= 8000) {
            console.log('Reached the 8000 song limit for a playlist. Using next playlist...')
            j++;

            // If we have reached the end of the playlistIds array, create a new playlist
            if (j >= playlistIds.length) {
                console.log('Reached the end of the playlistIds array. Creating a new playlist...')

                let newPlaylist;
                try {
                    newPlaylist = await spotifyApi.createPlaylist(`Discover House ${playlistIds.length + 1}`, { public: false });
                }
                catch (err) {
                    await retryRequest(err, failCount);
                    failCount++;
                    j--;
                    continue;
                }

                playlistIds.push(newPlaylist.body.id);
                playlistTracksResults[playlistIds[j]] = [];
            }
        }

        const fetchPlaylistTracks = await checkIfPlaylistHasChanged(playlistIds[j]);
        if (!fetchPlaylistTracks) {
            console.log('Playlist', playlistIds[j], 'has not changed since last update. Using last playlist tracks.')
            playlistTracksResults[playlistIds[j]] = lastPlaylistTracks[playlistIds[j]];
            continue;
        }
        const initialOffset = useInitialOffset ? Math.floor(lastPlaylistTracks[playlistIds[j]].length / 50) : 0;

        const playlistId = playlistIds[j];
        console.log('Fetching playlist tracks for playlist', playlistId)
        let tracks = [];
        for (let i = initialOffset; i < 250; i += 10) {
            console.log('Getting playlist tracks', i * 50, 'to', (i * 50) + 500, 'for playlist', playlistId)
            try {
                const fetchedTracks = await Promise.all(Array.from({ length: 10 }, (_, index) =>
                    spotifyApi.getPlaylistTracks(playlistId, { limit: 50, offset: (i + index) * 50 })
                ));
                const filteredTracks = fetchedTracks.flatMap((fetchedTrack) =>
                    fetchedTrack.body.items
                        .filter((item) => item && item.track)
                        .map((item) => {
                            return {
                                name: item.track!.name,
                                artist: item.track!.artists[0].name,
                                uri: item.track!.uri
                            }
                        })
                );
                if (filteredTracks.length === 0) {
                    console.log('No more playlist tracks')
                    break;
                }
                tracks.push(...filteredTracks);
                if (fetchedTracks.length < 10) break;
            }
            catch (err) {
                await retryRequest(err, failCount);
                i -= 10;
                continue;
            }
        }
        playlistTracksResults[playlistId] = tracks;
        console.log('New playlist tracks: ', playlistTracksResults[playlistId].length)
    }

    writeToDataFile(Date.now(), lastLikedTracks, playlistIds, playlistTracksResults, artists, results);
    return playlistTracksResults;
}



export const removeLikedTracksFromPlaylist = async (playlistId: string, playlistTracks: FilteredTrack[], likedTracks: FilteredTrack[]) => {
    const tracksToRemove = playlistTracks.filter((track) => likedTracks.find((t) => t.uri === track.uri));
    console.log('Removing', tracksToRemove.length, 'tracks from playlist', playlistId)

    for (let i = 0; i < tracksToRemove.length; i++) {
        console.log('Removing track', tracksToRemove[i])
        try {
            await spotifyApi.removeTracksFromPlaylist(playlistId, [{ uri: tracksToRemove[i].uri }]);
        }
        catch (err) {
            console.error((err as any).message)
            console.log('Rate limit hit. Waiting 1 second and trying again.')
            await new Promise((resolve) => setTimeout(resolve, 1000));
            i--;
            continue;
        }
    }

    console.log('Removed', tracksToRemove.length, 'tracks from playlist', playlistId)
    writeToDataFile(lastUpdated, lastLikedTracks, playlistIds, {
        ...lastPlaylistTracks, [playlistId]: playlistTracks.filter((track) => !tracksToRemove.includes(track))
    }, artists, results);
    return tracksToRemove;
}

export const removeDuplicateTracksFromPlaylist = async (playlistIds: string[]) => {

    let fetchPlaylistTracks = await getPlaylistTracks();
    for (let i = 0; i < playlistIds.length; i++) {
        const playlistId = playlistIds[i];
        console.log('Removing duplicate tracks from playlist', playlistId)
        const updatedPlaylistTracks = fetchPlaylistTracks[playlistId];

        const duplicateTracks = updatedPlaylistTracks.filter((track, index) => {
            const firstIndex = updatedPlaylistTracks.findIndex((t) => t.name === track.name && t.artist === track.artist);
            return firstIndex !== index;
        });

        console.log('Duplicate tracks:', duplicateTracks.length)
        if (duplicateTracks.length > 0) {
            console.log('Duplicate songs found in playlist', playlistId, '. Removing them...')

            let failCount = 0;
            for (let i = 0; i < Math.ceil(duplicateTracks.length / 50); i++) {
                console.log('Removing duplicate tracks', i * 50, 'to', (i * 50) + 50)
                try {
                    await spotifyApi.removeTracksFromPlaylist(playlistId, duplicateTracks.slice(i * 50, (i * 50) + 50).map((track) => {
                        return { uri: track.uri }
                    }));
                }
                catch (err) {
                    await retryRequest(err, failCount);
                    failCount++;
                    i--;
                    continue;
                }
            }
            console.log('Removed', duplicateTracks.length, 'duplicate songs from playlist', playlistId)
            fetchPlaylistTracks[playlistId] = updatedPlaylistTracks.filter((track) => !duplicateTracks.includes(track));
        }
    }

    writeToDataFile(lastUpdated, lastLikedTracks, playlistIds, fetchPlaylistTracks, artists, results);
    return fetchPlaylistTracks;
}

export const removeDuplicateTracksFromLikedSongs = async () => {
    const tracksHaveChanged = await checkIfLikedTracksHaveChanged();

    let likedTracks: FilteredTrack[] = []
    if (tracksHaveChanged) {
        console.log('Liked tracks have changed. Fetching new liked tracks...')
        likedTracks = await getLikedTracks();
    }
    else {
        console.log('Liked tracks have not changed since last update. Using last liked tracks.')
        likedTracks = lastLikedTracks;
    }

    const duplicateTracks = likedTracks.filter((track, index) => {
        const firstIndex = likedTracks.findIndex((t) => t.name === track.name && t.artist === track.artist);
        return firstIndex !== index;
    })

    if (duplicateTracks.length > 0) {
        console.log('Duplicate songs found in liked tracks. Removing them...')

        let failCount = 0;
        for (let i = 0; i < Math.ceil(duplicateTracks.length / 50); i++) {
            console.log('Removing duplicate tracks', i * 50, 'to', (i * 50) + 50)
            try {
                await spotifyApi.removeFromMySavedTracks(duplicateTracks.slice(i * 50, (i * 50) + 50).map((track) => track.uri.split("spotify:track:")[1]));
            }
            catch (err) {
                await retryRequest(err, failCount);
                failCount++;
                i--;
                continue;
            }
        }
        console.log('Removed', duplicateTracks.length, 'duplicate songs from liked tracks')

        writeToDataFile(lastUpdated, likedTracks.filter((track) => !duplicateTracks.includes(track)), playlistIds, lastPlaylistTracks, artists, results);
    }
}

export const retryRequest = async (err: any, failCount: number) => {
    // If err is an object, it is an error from the Spotify API
    console.error(typeof (err as any).message === 'object' ? JSON.stringify((err as any).message) : err.message ? err.message : err);
    // Use exponential backoff to retry requests
    const waitTime = Math.pow(2, failCount) * 1000;
    console.log('Rate limit hit. Waiting', waitTime / 1000, 'seconds and trying again.')
    await new Promise((resolve) => setTimeout(resolve, waitTime));
}

export const checkIfPlaylistHasChanged = async (playlistId: string) => {
    let fetchPlaylistTracks = false;
    console.log('Checking if playlist', playlistId, 'has changed since last update...')
    const playlistTotal = (await spotifyApi.getPlaylist(playlistId)).body.tracks.total;

    console.log('playlistTotal', playlistTotal)
    console.log('lastPlaylistTracks[playlistId].length', lastPlaylistTracks[playlistId].length)
    // If the playlist has changed since we last fetched it, fetch it again
    if (playlistTotal !== lastPlaylistTracks[playlistId].length) fetchPlaylistTracks = true;

    return fetchPlaylistTracks;
}

export const checkIfLikedTracksHaveChanged = async () => {
    let fetchLikedTracks = false;
    const lastAddedTrack = await spotifyApi.getMySavedTracks({ limit: 1 });
    if (new Date(lastAddedTrack.body.items[0].added_at).getTime() > lastUpdated) fetchLikedTracks = true;
    return fetchLikedTracks;
}

export const removeDuplicatesFromArtistTracks = (artistTracks: FilteredTrack[]) => {
    const seen = new Set();
    const uniqueSongs = artistTracks.filter((item) => {
        return seen.has(item.name) ? false : seen.add(item.name);
    }
    )
    return uniqueSongs;
}

export const getAllTracksByArtist = async (artistId: string, artistName: string, likedTracks: FilteredTrack[], artistIndex: number) => {
    console.log('Adding songs by', artistName, 'to the playlist...')

    const artistTracks: FilteredTrack[] = [];

    let albums = [];
    let failCount = 0;
    for (let i = 0; i < 50; i++) {
        try {
            console.log('Getting albums', i * 50, 'to', (i * 50) + 50)
            const albumData = await spotifyApi.getArtistAlbums(artistId, { limit: 50, offset: i * 50 });
            albums.push(...albumData.body.items);
            if (albumData.body.items.length < 50) break;
        }
        catch (err) {
            await retryRequest(err, failCount);
            failCount++;
            i--;
            continue;
        }
    }

    console.log('Albums by', artistName, ':', albums.length);
    let tracks = [];
    for (let i = 0; i < albums.length; i++) {
        const album = albums.slice(i * 10, (i * 10) + 10)

        let failCount = 0;
        const fetchedTracksPromises = [];
        for (let albumIndex = 0; albumIndex < album.length; albumIndex++) {
            for (let j = 0; j < 20; j += 20) {
                console.log('Getting tracks', (j * 50) + 1, 'to', (j * 50) + 50, 'for albums', (i * 10) + albumIndex + 1, 'to', (i * 10) + 10, 'out of', albums.length, ':', album[albumIndex].name, '-', artistName, '(', artistIndex + 1, '/', artists.length + ')')
                for (let k = j; k < j + 20; k++) {
                    if (k * 50 >= album[albumIndex].total_tracks) {
                        break;
                    }
                    const fetchedTracksPromise = spotifyApi.getAlbumTracks(album[albumIndex].id, { limit: 50, offset: k * 50 });
                    fetchedTracksPromises.push(fetchedTracksPromise);
                }
            }
        }
        try {
            const fetchedTracksResponses = await Promise.all(fetchedTracksPromises);
            for (const fetchedTracksResponse of fetchedTracksResponses) {
                const fetchedTracks = fetchedTracksResponse.body.items;
                tracks.push(...fetchedTracks);
                artistTracks.push(...fetchedTracks.map((track) => {
                    return {
                        name: track.name,
                        artist: artistName,
                        uri: track.uri
                    }
                }))
            }
        }
        catch (err) {
            await retryRequest(err, failCount);
            failCount++;
            i--;
            continue;
        }
    }
    for (let j = 0; j < tracks.length; j++) {
        console.log('Getting track', j + 1, 'of', tracks.length, 'for artist', artistName)
        const track = tracks[j];

        artistTracks.push({
            name: track.name,
            artist: artistName,
            uri: track.uri
        })
    }

    console.log('Songs by', artistName, ':', artistTracks.length)
    const uniqueSongs = removeDuplicatesFromArtistTracks(artistTracks);
    console.log('Unique songs by', artistName, ':', uniqueSongs.length)
    const unlikedTracks = uniqueSongs.filter((track) => !likedTracks.find((t) => t.uri === track.uri));
    // Remove songs already in any of the playlists
    const unlikedTracksInPlaylists = unlikedTracks.filter((track) => {
        return !Object.keys(lastPlaylistTracks).find((playlistId) => {
            return lastPlaylistTracks[playlistId].find((t) => t.uri === track.uri);
        })
    });
    const resultsRecord = {
        skipped: false,
        addedSongs: 0,
        skippedSongs: artistTracks.length - unlikedTracksInPlaylists.length,
        lastUpdated: Date.now()
    }
    console.log('Unliked/unadded songs by', artistName, ':', unlikedTracksInPlaylists.length)
    return { unlikedTracksInPlaylists, resultsRecord };
}

const cleanUp = async () => {
    const tokenFetched = await waitForAccessToken();
    if (tokenFetched) {
        console.log('Removing duplicate tracks from liked songs...')
        // Remove duplicate tracks from liked songs
        await removeDuplicateTracksFromLikedSongs();

        console.log('Removing duplicate tracks from playlists...')
        // Remove duplicate tracks from playlists
        const playlistTracks = await removeDuplicateTracksFromPlaylist(playlistIds);

        console.log('Removing duplicate artists...')
        // Remove duplicate artists
        removeDuplicateArtists(artists, playlistTracks);

        console.log('Done!')
    }
    else {
        console.log('Failed to fetch access token. Trying again in 1 second...')
        await new Promise((resolve) => setTimeout(resolve, 1000));
        cleanUp();
    }
}

cleanUp()