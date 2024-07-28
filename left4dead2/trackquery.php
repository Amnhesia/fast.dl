<?php

/*
 * SourceMod Radio - Track query wrapper URL
 * 
 * Make sure to modify the Allowed IP's to your game server ones - $AllowedIPs array
 * 
 */

/* 
 * Set these to your current game server IP's, or 127.0.0.1 if PHP is running locally on the server with Apache/Nginx.
 */
$AllowedIPs = array (
    "127.0.0.1",
    "1.1.1.1",
    "2.2.2.2",
    "3.3.3.3");

/* #############################################################################
 * -----------------------------------------------------------------------------
 * Nothing below this line should need to be edited.
 * -----------------------------------------------------------------------------
 * #############################################################################
 */

// Check if IP is on the access list
if (in_array($_SERVER['REMOTE_ADDR'], $AllowedIPs)) {
    // Validate the URL input
    $StreamURL = filter_input(INPUT_GET, "url", FILTER_VALIDATE_URL);
    // Is the URL input valid?
    if ($StreamURL !== null && $StreamURL !== false ) {
        // URL is valid - Let's grab the current track
        if (($CurrentTrack = getCurrentSongFromStream($StreamURL)) !== false) {
            echo $CurrentTrack;
        } else {
            echo "No song data provided.";
        }
    } else {
        die ("Unable to query track for URL");
    }
} else {
    die ("Server IP is disallowed. Contact the admin for support.");
}


/*
 * http://stackoverflow.com/questions/4911062/pulling-track-info-from-an-audio-stream-using-php
 * 
 * Using the modified function by Simon ( http://stackoverflow.com/users/1226018/simon )
 * 
 * Slightly modified by dubbeh
 * 
 */
function getCurrentSongFromStream($StreamURL) {
    $Result = false;
    $IcyMetaInt = -1;
    $Needle = 'StreamTitle=';

    $Options = ['http' => array(
            'method' => 'GET',
            'header' => 'Icy-MetaData: 1',
            'timeout' => '30.0',
            'user_agent' => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/27.0.1453.110 Safari/537.36'
        )];

    $ContextDefaults = stream_context_set_default($Options);
    $Stream = @fopen($StreamURL, 'r');

    if($Stream && ($MetaData = stream_get_meta_data($Stream)) && isset($MetaData['wrapper_data'])){
        foreach ($MetaData['wrapper_data'] as $Header){
            if (strpos(strtolower($Header), 'icy-metaint') !== false){
                $Temp = explode(":", $Header);
                $IcyMetaInt = trim($Temp[1]);
                break;
            }
        }
    }

    if($IcyMetaInt != -1)
    {
        $Buffer = stream_get_contents($Stream, 300, $IcyMetaInt);

        if(strpos($Buffer, $Needle) !== false)
        {
            $Title = explode($Needle, $Buffer);
            $Title = trim($Title[1]);
            $Result = substr($Title, 1, strpos($Title, ';') - 2);
        }
    }
    
    if($Stream) {
        fclose($Stream);
    }
    
    return $Result;
}

?>
